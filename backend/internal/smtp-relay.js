// SMTP relay for hosted services: they send to `smtp:25` on the comphost
// network with no auth, and CompHost hands each message to one of the
// configured upstream servers, chosen by sender address.
//
//   service ──25/587──▶ nginx stream (comphost subnet only, PROXY protocol)
//           ──▶ 127.0.0.1:2525 smtp-server (this file) ──▶ upstream via nodemailer
//
// nginx fronts the listener because the backend runs unprivileged and can't
// bind 25. Delivery is pass-through: DATA is answered only once the upstream
// has accepted the message (its error code is relayed otherwise), so nothing is
// ever queued or written to disk.
import fs from "node:fs";
import os from "node:os";
import nodemailer from "nodemailer";
import { SMTPServer } from "smtp-server";
import orchestrator from "../lib/compose/orchestrator.js";
import errs from "../lib/error.js";
import { global as logger } from "../logger.js";
import smtpRouteModel from "../models/smtp_route.js";
import smtpUpstreamModel from "../models/smtp_upstream.js";
import streamModel from "../models/stream.js";
import internalComphostSetting from "./comphost-setting.js";
import internalNginx from "./nginx.js";

const SETTING_KEY = "smtp_relay";
const COMPHOST_NETWORK = process.env.COMPHOST_NETWORK || "comphost";
const LISTEN_PORT = 2525;
export const RELAY_PORTS = [25, 587];
const ALIAS = "smtp";
const NGINX_CONF = "/data/nginx/stream/comphost-smtp-relay.conf";
const DEFAULT_MAX_MB = 25;
const RECENT_MAX = 50;

let server = null;
const status = { listening: false, subnet: null, alias: "unknown", error: null };
/** Last deliveries, newest first — shown in the UI instead of flooding the audit log */
const recent = [];

// --- addresses ----------------------------------------------------------------

/** "Name <a@b>" → { name, address }; a bare address has no name. */
const parseMailbox = (value) => {
	const v = String(value || "").trim();
	const m = v.match(/^(.*?)<([^>]*)>\s*$/);
	if (m) {
		return { name: m[1].trim(), address: m[2].trim() };
	}
	return { name: "", address: v };
};

/** How specific a route's match is: exact address, then @domain, then *. */
const specificity = (match) => (match === "*" ? 2 : match.startsWith("@") ? 1 : 0);

const routeMatches = (match, address) => {
	const m = match.trim().toLowerCase();
	const a = address.toLowerCase();
	if (m === "*") return true;
	if (m.startsWith("@")) return a.endsWith(m);
	return a === m;
};

// --- headers ------------------------------------------------------------------

/**
 * Split a raw message into header fields and the rest. latin1 keeps every byte
 * as-is, so 8-bit headers and the body round-trip untouched.
 */
const splitMessage = (raw) => {
	const s = raw.toString("latin1");
	let end = s.indexOf("\r\n\r\n");
	if (end < 0) end = s.indexOf("\n\n");
	const head = end < 0 ? s : s.slice(0, end);
	const rest = end < 0 ? "" : s.slice(end);
	const fields = [];
	for (const line of head.split(/\r?\n/)) {
		if (/^[ \t]/.test(line) && fields.length) {
			fields[fields.length - 1].lines.push(line); // folded continuation
		} else if (line) {
			fields.push({ name: line.slice(0, line.indexOf(":")).trim().toLowerCase(), lines: [line] });
		}
	}
	return { fields, rest };
};

const fieldValue = (field) =>
	field.lines
		.join(" ")
		.slice(field.lines[0].indexOf(":") + 1)
		.trim();

/**
 * Rewrite the sender so the upstream accepts the message: From becomes
 * `rewriteFrom` (keeping the display name), the original From goes into
 * X-Original-From and — unless a Reply-To exists and should be kept — Reply-To.
 * Only the header block changes; the body is passed through byte for byte.
 */
const rewriteSender = (raw, rewriteFrom, keepReplyTo) => {
	const { fields, rest } = splitMessage(raw);
	const fromField = fields.find((f) => f.name === "from");
	const original = fromField ? fieldValue(fromField) : "";
	const hasReplyTo = fields.some((f) => f.name === "reply-to");
	const { name } = parseMailbox(original);

	const drop = new Set(["from", "sender", "x-original-from"]);
	if (original && !(hasReplyTo && keepReplyTo)) drop.add("reply-to");
	const kept = fields.filter((f) => !drop.has(f.name));

	const added = [`From: ${name ? `${name} <${rewriteFrom}>` : rewriteFrom}`];
	if (original) {
		added.push(`X-Original-From: ${original}`);
		if (!(hasReplyTo && keepReplyTo)) added.push(`Reply-To: ${original}`);
	}
	const head = [...added, ...kept.flatMap((f) => f.lines)].join("\r\n");
	return { raw: Buffer.from(head + (rest || "\r\n\r\n"), "latin1"), original };
};

// --- network ------------------------------------------------------------------

const ipv4ToInt = (ip) => ip.split(".").reduce((acc, octet) => (acc << 8) + Number.parseInt(octet, 10), 0) >>> 0;

const inSubnet = (ip, cidr) => {
	const addr = String(ip || "").replace(/^::ffff:/, "");
	if (!cidr || !/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return false;
	const [base, bits] = cidr.split("/");
	const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
	return (ipv4ToInt(addr) & mask) === (ipv4ToInt(base) & mask);
};

/** The comphost network's IPv4 subnet, e.g. "172.20.0.0/16". */
const comphostSubnet = async () => {
	const { stdout, exitCode } = await orchestrator.run(["network", "inspect", COMPHOST_NETWORK, "--format", "json"]);
	if (exitCode !== 0) return null;
	try {
		const net = JSON.parse(stdout);
		const configs = (Array.isArray(net) ? net[0] : net)?.IPAM?.Config || [];
		return configs.map((c) => c.Subnet).find((s) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s || "")) || null;
	} catch {
		return null;
	}
};

const inspectJson = async (ids) => {
	if (!ids.length) return [];
	const { stdout, exitCode } = await orchestrator.run(["inspect", "--format", "json", ...ids]);
	if (exitCode !== 0) return [];
	try {
		return JSON.parse(stdout);
	} catch {
		return [];
	}
};

/**
 * Give this container the `smtp` alias on comphost. New installs get it from
 * docker-compose.yml; running ones get it here, by reconnecting once. Refuses
 * when another container already answers to `smtp`, since docker would then
 * spread connections across both.
 * @returns {Promise<string>} ok | added | conflict | unknown
 */
const ensureAlias = async () => {
	const [self] = await inspectJson([os.hostname()]);
	const endpoint = self?.NetworkSettings?.Networks?.[COMPHOST_NETWORK];
	if (!endpoint) return "unknown"; // not on comphost (or not in a container)
	if ((endpoint.Aliases || []).includes(ALIAS)) return "ok";

	const ps = await orchestrator.run(["ps", "-q", "--no-trunc", "--filter", `network=${COMPHOST_NETWORK}`]);
	const others = (await inspectJson(ps.stdout.split(/\s+/).filter(Boolean))).filter((c) => c.Id !== self.Id);
	if (others.some((c) => (c.NetworkSettings?.Networks?.[COMPHOST_NETWORK]?.Aliases || []).includes(ALIAS))) {
		return "conflict";
	}
	const keep = (endpoint.Aliases || []).filter((a) => !self.Id.startsWith(a));
	await orchestrator.connectContainerToNetwork(self.Id, COMPHOST_NETWORK, [...keep, ALIAS]);
	logger.info(`SMTP relay: added the "${ALIAS}" alias on ${COMPHOST_NETWORK}`);
	return "added";
};

// --- delivery -----------------------------------------------------------------

const transportFor = (upstream) =>
	nodemailer.createTransport({
		host: upstream.host,
		port: upstream.port,
		secure: upstream.security === "tls",
		requireTLS: upstream.security === "starttls",
		ignoreTLS: upstream.security === "none",
		auth: upstream.username ? { user: upstream.username, pass: upstream.password } : undefined,
		connectionTimeout: 15 * 1000,
		greetingTimeout: 15 * 1000,
	});

/** An SMTP-coded error smtp-server sends back to the client as-is. */
const smtpError = (code, message) => {
	const err = new Error(message);
	err.responseCode = code;
	return err;
};

const remember = (entry) => {
	recent.unshift({ at: new Date().toISOString(), ...entry });
	recent.length = Math.min(recent.length, RECENT_MAX);
};

/**
 * Route one message by sender and hand it to the upstream. Throws an error
 * carrying the SMTP code the client should see.
 * @param   {string}   envelopeFrom  MAIL FROM (may be empty for bounces)
 * @param   {string[]} recipients
 * @param   {Buffer}   raw           the message as received
 * @returns {Promise<{route: string, upstream: string, from: string}>}
 */
const deliver = async (envelopeFrom, recipients, raw) => {
	const headerFrom = splitMessage(raw).fields.find((f) => f.name === "from");
	const sender = envelopeFrom || (headerFrom ? parseMailbox(fieldValue(headerFrom)).address : "");
	const routes = (await smtpRouteModel.query()).sort((a, b) => specificity(a.match) - specificity(b.match));
	const route = routes.find((r) => routeMatches(r.match, sender));
	if (!route) {
		throw smtpError(550, `No route for sender ${sender || "<>"}`);
	}
	const upstream = await smtpUpstreamModel.query().findById(route.upstream_id);
	if (!upstream) {
		throw smtpError(451, `Route ${route.match} points at a missing upstream`);
	}

	let message = raw;
	let from = envelopeFrom;
	if (route.rewrite_from) {
		message = rewriteSender(raw, route.rewrite_from, route.keep_reply_to).raw;
		from = route.rewrite_from;
	}

	try {
		await transportFor(upstream).sendMail({ envelope: { from, to: recipients }, raw: message });
	} catch (err) {
		// Relay the upstream's verdict; connection trouble is temporary.
		const code = Number(err.responseCode) || 451;
		throw smtpError(code, `${upstream.name}: ${err.response || err.message}`);
	}
	return { route: route.match, upstream: upstream.name, from };
};

const startServer = async (maxBytes) => {
	if (server) return;
	server = new SMTPServer({
		name: "comphost-smtp",
		banner: "CompHost SMTP relay",
		authOptional: true,
		disabledCommands: ["AUTH", "STARTTLS"],
		// Only the local nginx front may send a PROXY header; it carries the
		// real client address used for the subnet check below.
		useProxy: ["127.0.0.1"],
		size: maxBytes,
		rejectOversized: true,
		onConnect(session, callback) {
			if (!inSubnet(session.remoteAddress, status.subnet)) {
				callback(smtpError(554, `Relaying is only offered on the ${COMPHOST_NETWORK} network`));
				return;
			}
			callback();
		},
		onData(stream, session, callback) {
			const chunks = [];
			stream.on("data", (c) => chunks.push(c));
			stream.on("end", () => {
				if (stream.sizeExceeded) {
					callback(smtpError(552, "Message exceeds the relay's size limit"));
					return;
				}
				const from = session.envelope.mailFrom?.address || "";
				const to = session.envelope.rcptTo.map((r) => r.address);
				deliver(from, to, Buffer.concat(chunks))
					.then((r) => {
						logger.info(
							`SMTP relay: ${from || "<>"} → ${to.length} recipient(s) via ${r.upstream} (${r.route})`,
						);
						remember({ from, to: to.length, upstream: r.upstream, route: r.route, ok: true });
						callback(null, `Accepted by ${r.upstream}`);
					})
					.catch((err) => {
						logger.warn(`SMTP relay: ${from || "<>"} rejected: ${err.message}`);
						remember({ from, to: to.length, ok: false, error: `${err.responseCode} ${err.message}` });
						callback(err);
					});
			});
		},
	});
	server.on("error", (err) => {
		status.error = err.message;
		logger.error(`SMTP relay: ${err.message}`);
	});
	await new Promise((resolve, reject) => {
		server.listen(LISTEN_PORT, "127.0.0.1", resolve).once("error", reject);
	});
	status.listening = true;
};

const stopServer = async () => {
	if (!server) return;
	await new Promise((resolve) => server.close(resolve));
	server = null;
	status.listening = false;
};

/** The nginx stream front: 25 and 587, comphost subnet only, PROXY protocol on. */
const writeNginxConf = (subnet) => {
	const listen = RELAY_PORTS.map((p) => `\tlisten ${p};`).join("\n");
	fs.writeFileSync(
		NGINX_CONF,
		`# CompHost SMTP relay front — generated by CompHost, do not edit
server {
${listen}
	allow ${subnet};
	deny all;
	proxy_pass 127.0.0.1:${LISTEN_PORT};
	proxy_protocol on;
}
`,
	);
};

// --- config -------------------------------------------------------------------

const getSettings = async () => {
	const s = (await internalComphostSetting.getRaw(SETTING_KEY)) || {};
	return { enabled: !!s.enabled, max_size_mb: Number(s.max_size_mb) || DEFAULT_MAX_MB };
};

const maskUpstream = (u) => ({ ...u, password: "", has_password: !!u.password });

const streamsOnRelayPorts = () => streamModel.query().where("is_deleted", 0).whereIn("incoming_port", RELAY_PORTS);

const internalSmtpRelay = {
	/**
	 * Bring the relay in line with its settings: listener, nginx front, alias.
	 * Called at boot and whenever the settings change.
	 */
	apply: async () => {
		const settings = await getSettings();
		status.error = null;
		if (!settings.enabled) {
			await stopServer();
			if (fs.existsSync(NGINX_CONF)) {
				fs.unlinkSync(NGINX_CONF);
				await internalNginx.reload().catch((err) => logger.warn(`nginx reload: ${err.message}`));
			}
			return;
		}
		status.subnet = await comphostSubnet();
		if (!status.subnet) {
			status.error = `The ${COMPHOST_NETWORK} network was not found`;
			return;
		}
		await stopServer();
		await startServer(settings.max_size_mb * 1024 * 1024);
		writeNginxConf(status.subnet);
		try {
			await internalNginx.reload();
		} catch (err) {
			fs.unlinkSync(NGINX_CONF);
			await stopServer();
			status.error = `nginx rejected the relay config: ${err.message}`;
			throw new errs.ValidationError(status.error);
		}
		status.alias = await ensureAlias().catch((err) => {
			logger.warn(`SMTP relay alias: ${err.message}`);
			return "unknown";
		});
	},

	/** Boot: start the relay if it's enabled; never block startup on it. */
	init: () =>
		internalSmtpRelay.apply().catch((err) => {
			status.error = err.message;
			logger.error(`SMTP relay failed to start: ${err.message}`);
		}),

	/**
	 * Refuse a stream host on a relay port while the relay is on — called by
	 * stream create/update.
	 * @param {Number} port
	 */
	assertPortFree: async (port) => {
		if (RELAY_PORTS.includes(Number(port)) && (await getSettings()).enabled) {
			throw new errs.ValidationError(`Port ${port} is used by the SMTP relay (Settings → Mail relay)`);
		}
	},

	getConfig: async () => ({
		...(await getSettings()),
		status: { ...status },
		upstreams: (await smtpUpstreamModel.query().orderBy("name")).map(maskUpstream),
		routes: (await smtpRouteModel.query()).sort(
			(a, b) => specificity(a.match) - specificity(b.match) || a.match.localeCompare(b.match),
		),
		recent,
	}),

	setSettings: async (data) => {
		const current = await getSettings();
		const next = {
			enabled: data.enabled ?? current.enabled,
			max_size_mb: data.max_size_mb ?? current.max_size_mb,
		};
		if (next.enabled && !current.enabled) {
			const taken = await streamsOnRelayPorts();
			if (taken.length) {
				throw new errs.ValidationError(
					`Stream host(s) already use port ${[...new Set(taken.map((s) => s.incoming_port))].join(" and ")}; move them first`,
				);
			}
		}
		await internalComphostSetting.setRaw(SETTING_KEY, next);
		await internalSmtpRelay.apply();
		return internalSmtpRelay.getConfig();
	},

	saveUpstream: async (data) => {
		const row = {
			name: data.name,
			host: data.host,
			port: data.port,
			security: data.security,
			username: data.username || "",
		};
		if (data.id) {
			// An empty password keeps the stored one (it's never sent back)
			if (data.password) row.password = data.password;
			await smtpUpstreamModel.query().patchAndFetchById(data.id, row);
		} else {
			await smtpUpstreamModel.query().insert({ ...row, password: data.password || "" });
		}
		return internalSmtpRelay.getConfig();
	},

	deleteUpstream: async (id) => {
		const used = await smtpRouteModel.query().where("upstream_id", id);
		if (used.length) {
			throw new errs.ValidationError(
				`Used by route(s) ${used.map((r) => r.match).join(", ")}; delete those first`,
			);
		}
		await smtpUpstreamModel.query().deleteById(id);
		return internalSmtpRelay.getConfig();
	},

	/** Connect and log in to an upstream without sending anything. */
	testUpstream: async (id) => {
		const upstream = await smtpUpstreamModel.query().findById(id);
		if (!upstream) throw new errs.ItemNotFoundError(id);
		try {
			await transportFor(upstream).verify();
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err.response || err.message };
		}
	},

	saveRoute: async (data) => {
		const match = data.match.trim().toLowerCase();
		if (!(match === "*" || /^@[^@\s]+$/.test(match) || /^[^@\s]+@[^@\s]+$/.test(match))) {
			throw new errs.ValidationError('A route matches an address, "@domain" or "*"');
		}
		if (!(await smtpUpstreamModel.query().findById(data.upstream_id))) {
			throw new errs.ValidationError("Choose an upstream server");
		}
		const clash = await smtpRouteModel
			.query()
			.where("match", match)
			.whereNot("id", data.id || 0)
			.first();
		if (clash) throw new errs.ValidationError(`There is already a route for ${match}`);
		const row = {
			match,
			upstream_id: data.upstream_id,
			rewrite_from: (data.rewrite_from || "").trim(),
			keep_reply_to: data.keep_reply_to !== false,
		};
		if (data.id) await smtpRouteModel.query().patchAndFetchById(data.id, row);
		else await smtpRouteModel.query().insert(row);
		return internalSmtpRelay.getConfig();
	},

	deleteRoute: async (id) => {
		await smtpRouteModel.query().deleteById(id);
		return internalSmtpRelay.getConfig();
	},

	/**
	 * Send a test message through routing, rewriting and the upstream — the same
	 * path a hosted service's mail takes after the listener.
	 */
	sendTest: async ({ from, to }) => {
		const raw = Buffer.from(
			[
				`From: ${from}`,
				`To: ${to}`,
				"Subject: CompHost SMTP relay test",
				`Date: ${new Date().toUTCString()}`,
				`Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@comphost>`,
				"MIME-Version: 1.0",
				"Content-Type: text/plain; charset=utf-8",
				"",
				"This message was sent from Settings → Mail relay in CompHost.",
				"",
			].join("\r\n"),
		);
		try {
			const r = await deliver(parseMailbox(from).address, [parseMailbox(to).address], raw);
			remember({ from, to: 1, upstream: r.upstream, route: r.route, ok: true, test: true });
			return { ok: true, ...r };
		} catch (err) {
			remember({ from, to: 1, ok: false, error: `${err.responseCode} ${err.message}`, test: true });
			return { ok: false, error: `${err.responseCode} ${err.message}` };
		}
	},
};

export default internalSmtpRelay;
export { inSubnet, rewriteSender, routeMatches };
