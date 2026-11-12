// One list of everything CompHost serves — proxy, redirection, 404 and stream
// hosts flattened to a row per domain (or per port for streams) — with SSL
// state, the stack behind it, and a link suggestion for hosts that point at a
// stack's container but were never linked to it (anything set up before the
// stack was adopted).
import moment from "moment";
import errs from "../lib/error.js";
import proxyHostModel from "../models/proxy_host.js";
import stackModel from "../models/stack.js";
import streamModel from "../models/stream.js";
import internalAuditLog from "./audit-log.js";
import internalDeadHost from "./dead-host.js";
import internalDrift from "./drift.js";
import internalProxyHost from "./proxy-host.js";
import internalRedirectionHost from "./redirection-host.js";
import internalStack from "./stack.js";
import internalStream from "./stream.js";

const EXPIRING_DAYS = 14;

// Only proxy and stream hosts have a stack_id (0 = not linked).
const LINKABLE = {
	proxy: { internal: internalProxyHost, model: proxyHostModel, perm: "proxy_hosts", auditType: "proxy-host" },
	stream: { internal: internalStream, model: streamModel, perm: "streams", auditType: "stream" },
};

/**
 * A kind the user may not list is simply absent, not an error for the page.
 * @param   {Promise<Array>} p
 * @returns {Promise<Array>}
 */
const visibleOrEmpty = (p) =>
	p.catch((err) => {
		if (err instanceof errs.PermissionError) {
			return [];
		}
		throw err;
	});

/**
 * @param   {Object} host  a host row with its certificate expanded
 * @returns {string} none | valid | expiring | expired
 */
const sslStateOf = (host) => {
	const cert = host.certificate;
	if (!host.certificate_id || !cert) {
		return "none";
	}
	if (!cert.expires_on) {
		return "valid";
	}
	const expires = moment(cert.expires_on);
	if (expires.isBefore(moment())) {
		return "expired";
	}
	return expires.diff(moment(), "days") < EXPIRING_DAYS ? "expiring" : "valid";
};

const certificateOf = (host) =>
	host.certificate_id && host.certificate
		? {
				id: host.certificate.id,
				provider: host.certificate.provider,
				nice_name: host.certificate.nice_name,
				expires_on: host.certificate.expires_on,
			}
		: null;

/**
 * Index every stack container by what a host might use to reach it.
 * Only names that point at exactly one managed stack service are kept, so a
 * suggestion is never a guess between two candidates.
 * @param   {Array} containers  from internalStack.liveContainers()
 * @returns {Map<string, {stack_id: number, service: string}>}
 */
const targetIndex = (containers) => {
	const seen = new Map();
	const add = (key, entry) => {
		const k = String(key || "").toLowerCase();
		if (!k) return;
		const prev = seen.get(k);
		if (prev === undefined) {
			seen.set(k, entry);
		} else if (prev && (prev.stack_id !== entry.stack_id || prev.service !== entry.service)) {
			seen.set(k, null); // ambiguous
		}
	};
	for (const c of containers) {
		if (!c.stack_id || !c.service) continue;
		const entry = { stack_id: c.stack_id, service: c.service };
		add(c.name, entry);
		for (const net of Object.values(c.networks)) {
			add(net.ip, entry);
			for (const alias of net.aliases) {
				add(alias, entry);
			}
		}
	}
	return seen;
};

const internalDomains = {
	/**
	 * @param   {Access} access
	 * @returns {Promise<Array<Object>>}
	 */
	getAll: async (access) => {
		const expand = ["certificate", "owner"];
		const [proxies, redirects, deads, streams] = await Promise.all([
			visibleOrEmpty(internalProxyHost.getAll(access, expand)),
			visibleOrEmpty(internalRedirectionHost.getAll(access, expand)),
			visibleOrEmpty(internalDeadHost.getAll(access, expand)),
			visibleOrEmpty(internalStream.getAll(access, expand)),
		]);

		// Stack names only for users who may see stacks at all.
		const canSeeStacks = await access
			.can("stacks:list")
			.then(() => true)
			.catch(() => false);
		const stacks = canSeeStacks ? await stackModel.query().where("is_deleted", 0) : [];
		const stackById = new Map(stacks.map((s) => [s.id, s]));
		const stackRef = (host) => {
			const s = stackById.get(host.stack_id);
			return s ? { id: s.id, name: s.name, service: host.meta?.comphost_service || null } : null;
		};

		// Docker is only asked when there's something to suggest a link for.
		const needsIndex = canSeeStacks && stacks.length && [...proxies, ...streams].some((h) => !h.stack_id);
		const index = needsIndex ? targetIndex(await internalStack.liveContainers()) : new Map();
		const suggest = (host, target) => {
			if (host.stack_id) return null;
			const hit = index.get(String(target || "").toLowerCase());
			if (!hit) return null;
			return {
				stack_id: hit.stack_id,
				stack_name: stackById.get(hit.stack_id)?.name ?? null,
				service: hit.service,
			};
		};

		const base = (kind, host) => ({
			kind,
			host_id: host.id,
			enabled: !!host.enabled,
			owner: host.owner ? { id: host.owner.id, name: host.owner.name } : null,
			certificate: certificateOf(host),
			ssl_state: sslStateOf(host),
			ssl_forced: !!host.ssl_forced,
			// nginx rejected this host's config, so it isn't being served
			online: host.meta?.nginx_online !== false,
			nginx_err: host.meta?.nginx_online === false ? host.meta?.nginx_err || null : null,
			stack: stackRef(host),
			// Only proxy and stream hosts can be linked, and so drift
			drift: host.stack_id ? internalDrift.forHost(kind, host.id, host.stack_id) : [],
		});

		const rows = [];
		for (const h of proxies) {
			const b = base("proxy", h);
			for (const domain of h.domain_names || []) {
				rows.push({
					...b,
					domain,
					target: `${h.forward_scheme}://${h.forward_host}:${h.forward_port}`,
					link_suggestion: suggest(h, h.forward_host),
				});
			}
		}
		for (const h of redirects) {
			const b = base("redirect", h);
			const scheme = h.forward_scheme === "auto" ? "" : `${h.forward_scheme}://`;
			for (const domain of h.domain_names || []) {
				rows.push({
					...b,
					domain,
					target: `${h.forward_http_code} → ${scheme}${h.forward_domain_name}`,
					link_suggestion: null,
				});
			}
		}
		for (const h of deads) {
			const b = base("dead", h);
			for (const domain of h.domain_names || []) {
				rows.push({ ...b, domain, target: "404", link_suggestion: null });
			}
		}
		for (const h of streams) {
			const protocols = [h.tcp_forwarding ? "tcp" : null, h.udp_forwarding ? "udp" : null].filter(Boolean);
			rows.push({
				...base("stream", h),
				domain: `:${h.incoming_port}/${protocols.join("+")}`,
				target: `${h.forwarding_host}:${h.forwarding_port}`,
				link_suggestion: suggest(h, h.forwarding_host),
			});
		}
		// Domains alphabetically, stream ports after them
		return rows.sort(
			(a, b) =>
				(a.kind === "stream") - (b.kind === "stream") ||
				a.domain.localeCompare(b.domain, undefined, { numeric: true }),
		);
	},

	/**
	 * Link a proxy or stream host to a stack service — or unlink it with no
	 * stack_id. Records the same fields Expose writes, so the host shows under
	 * the stack and is re-attached after redeploys. The host's target and nginx
	 * config are left exactly as they are.
	 * @param   {Access} access
	 * @param   {Object} data  { kind, host_id, stack_id, service }
	 * @returns {Promise<Object>} the updated host
	 */
	link: async (access, data) => {
		if (!LINKABLE[data.kind]) {
			throw new errs.ValidationError("Only proxy and stream hosts can be linked to a stack");
		}
		const { internal, model, perm, auditType } = LINKABLE[data.kind];
		await access.can(`${perm}:update`, data.host_id);
		// can() doesn't check ownership; get() applies the owner filter for
		// users who only see their own hosts, and throws if it isn't theirs.
		const host = await internal.get(access, { id: data.host_id });

		const meta = { ...(host.meta || {}) };
		let stackId = 0;
		if (data.stack_id) {
			await access.can("stacks:update", data.stack_id);
			const stack = await stackModel.query().where("is_deleted", 0).andWhere("id", data.stack_id).first();
			if (!stack) {
				throw new errs.ItemNotFoundError(data.stack_id);
			}
			if (!data.service) {
				throw new errs.ValidationError("A service is required to link a host to a stack");
			}
			stackId = stack.id;
			meta.comphost_service = data.service;
			meta.comphost_stack_id = stack.id;
		} else {
			delete meta.comphost_service;
			delete meta.comphost_stack_id;
		}

		const updated = await model.query().patchAndFetchById(host.id, { stack_id: stackId, meta });
		await internalAuditLog.add(access, {
			action: stackId ? "linked" : "unlinked",
			object_type: auditType,
			object_id: host.id,
			// domain_names / incoming_port are what the audit log shows for these types
			meta: {
				domain_names: host.domain_names,
				incoming_port: host.incoming_port,
				stack_id: stackId || null,
				service: meta.comphost_service ?? null,
			},
		});
		return updated;
	},
};

export default internalDomains;
