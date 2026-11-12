// Drift watch: notice when a managed stack was changed outside CompHost.
//
// What counts, per stack:
//  - compose-edited   the compose file no longer matches what CompHost wrote or
//                     adopted. Reported only; "Accept" makes it the new baseline.
//  - compose-missing  the compose file is gone.
//  - service-down     a service behind an enabled host has no running container.
//  - off-network      a service behind a host isn't on the comphost network under
//                     the host's alias (e.g. `docker compose up` run on the box
//                     recreated it). Repaired automatically.
//  - ip-changed       a host linked after the fact targets an IP the service no
//                     longer has. Reported; the fix is to target an alias.
//  - unused-alias     informational: an alias on comphost that no host uses.
//
// Scans run on a two-minute tick and shortly after any relevant docker event.
// Findings live in memory; the audit log records each one once when it first
// appears or is repaired.
import { isIP } from "node:net";
import { isBusy } from "../lib/compose/busy.js";
import orchestrator from "../lib/compose/orchestrator.js";
import { global as logger } from "../logger.js";
import proxyHostModel from "../models/proxy_host.js";
import stackModel from "../models/stack.js";
import streamModel from "../models/stream.js";
import tokenModel from "../models/token.js";
import internalAuditLog from "./audit-log.js";
import internalStack from "./stack.js";

const COMPHOST_NETWORK = process.env.COMPHOST_NETWORK || "comphost";
const TICK_MS = 2 * 60 * 1000;
const EVENT_DEBOUNCE_MS = 5 * 1000;
const EVENTS_RESTART_MS = 30 * 1000;
// A repair is shown for a while after it happened, not just until the next scan.
const REPAIR_VISIBLE_MS = 60 * 60 * 1000;

/** stackId → { findings, checked_on } */
const state = new Map();
/** finding key → time of the repair, for findings that were fixed automatically */
const repairs = new Map();
/** finding keys already written to the audit log while they persist */
const reported = new Set();

let scanning = null;
let rescanQueued = false;
let debounce = null;

// Scheduled work has no user; audit entries are attributed the way upstream's
// certificate renewals are.
const systemAccess = () => ({ token: tokenModel(), can: () => Promise.resolve({ permission_visibility: "all" }) });

const keyOf = (stackId, f) => `${stackId}:${f.code}:${f.kind ?? ""}${f.host_id ?? ""}:${f.service ?? ""}`;

/**
 * Aliases docker or compose add on their own — not something a user chose.
 * @param   {Object} c      container from liveContainers()
 * @param   {string} alias
 * @returns {boolean}
 */
const isAutomaticAlias = (c, alias) => alias === c.service || alias === c.name || c.id.startsWith(alias);

/**
 * Check one stack. Repairs off-network services as it goes.
 * @param   {Object} stack
 * @param   {Array}  containers  this stack's containers
 * @param   {Array}  hosts       enabled proxy/stream hosts linked to this stack
 * @returns {Promise<Array<Object>>}
 */
const scanStack = async (stack, containers, hosts) => {
	const list = [];

	const hash = internalStack.composeFileHash(stack);
	if (!hash) {
		list.push({ code: "compose-missing", message: "The compose file is missing" });
	} else if (!stack.compose_hash) {
		// No baseline yet (stack predates drift watch): this is it.
		await stackModel.query().where("id", stack.id).patch({ compose_hash: hash });
	} else if (hash !== stack.compose_hash) {
		list.push({ code: "compose-edited", message: "The compose file was changed outside CompHost" });
	}

	for (const h of hosts) {
		const subject = { kind: h.kind, host_id: h.id, service: h.service };
		const running = containers.filter((c) => c.service === h.service && c.state === "running");
		if (!running.length) {
			list.push({ ...subject, code: "service-down", message: `Service ${h.service} isn't running` });
			continue;
		}
		if (isIP(h.target)) {
			const stillThere = running.some((c) => Object.values(c.networks).some((n) => n.ip === h.target));
			if (!stillThere) {
				list.push({
					...subject,
					code: "ip-changed",
					message: `Targets ${h.target}, which ${h.service} no longer has; point the host at an alias instead`,
				});
			}
			continue;
		}
		for (const c of running) {
			const net = c.networks[COMPHOST_NETWORK];
			if (net?.aliases.includes(h.target)) {
				continue;
			}
			// Keep whatever aliases it still has there, plus the one the host needs.
			const keep = (net?.aliases || []).filter((a) => !isAutomaticAlias(c, a));
			try {
				await orchestrator.connectContainerToNetwork(c.id, COMPHOST_NETWORK, [h.target, ...keep]);
				const finding = {
					...subject,
					code: "off-network",
					repaired: true,
					repaired_on: new Date().toISOString(),
					message: `${h.service} had dropped off ${COMPHOST_NETWORK} as "${h.target}"; re-attached`,
				};
				repairs.set(keyOf(stack.id, finding), { finding, at: Date.now() });
			} catch (err) {
				list.push({
					...subject,
					code: "off-network",
					message: `${h.service} isn't reachable as "${h.target}" on ${COMPHOST_NETWORK}: ${err.message}`,
				});
			}
		}
	}

	const targets = new Set(hosts.map((h) => h.target));
	for (const c of containers) {
		for (const alias of c.networks[COMPHOST_NETWORK]?.aliases || []) {
			if (!isAutomaticAlias(c, alias) && !targets.has(alias)) {
				list.push({
					code: "unused-alias",
					level: "info",
					service: c.service,
					message: `${c.service} answers as "${alias}" on ${COMPHOST_NETWORK}, but no host uses it`,
				});
			}
		}
	}

	// Recent repairs stay visible, unless the same thing is broken again now.
	const now = Date.now();
	const current = new Set(list.map((f) => keyOf(stack.id, f)));
	for (const [key, r] of repairs) {
		if (!key.startsWith(`${stack.id}:`)) continue;
		if (now - r.at > REPAIR_VISIBLE_MS) {
			repairs.delete(key);
		} else if (!current.has(key)) {
			list.push(r.finding);
		}
	}
	return list;
};

/**
 * Write each finding to the audit log once, when it first appears; forget it
 * when it's gone so a recurrence is logged again.
 */
const audit = async (stack, list) => {
	const live = new Set();
	for (const f of list) {
		if (f.level === "info") continue;
		// Each repair is its own event; an open problem is logged once while it lasts.
		const key = `${keyOf(stack.id, f)}:${f.repaired ? f.repaired_on : "open"}`;
		live.add(key);
		if (reported.has(key)) continue;
		reported.add(key);
		await internalAuditLog
			.add(systemAccess(), {
				action: f.repaired ? "drift-repaired" : "drift-detected",
				object_type: "stack",
				object_id: stack.id,
				meta: { name: stack.name, code: f.code, service: f.service ?? null, message: f.message },
			})
			.catch((err) => logger.warn(`Drift audit entry failed: ${err.message}`));
		logger[f.repaired ? "info" : "warn"](`Drift in stack ${stack.name}: ${f.message}`);
	}
	for (const key of reported) {
		if (key.startsWith(`${stack.id}:`) && !live.has(key)) reported.delete(key);
	}
};

const scanAll = async () => {
	const stacks = await stackModel.query().where("is_deleted", 0);
	const [containers, proxies, streams] = await Promise.all([
		stacks.length ? internalStack.liveContainers() : [],
		proxyHostModel.query().where("is_deleted", 0).andWhere("stack_id", ">", 0),
		streamModel.query().where("is_deleted", 0).andWhere("stack_id", ">", 0),
	]);
	// Disabled hosts aren't served, so nothing behind them can drift.
	const hosts = [
		...proxies.filter((h) => h.enabled).map((h) => ({ kind: "proxy", target: h.forward_host, h })),
		...streams.filter((h) => h.enabled).map((h) => ({ kind: "stream", target: h.forwarding_host, h })),
	]
		.map(({ kind, target, h }) => ({
			kind,
			target,
			id: h.id,
			stack_id: h.stack_id,
			service: h.meta?.comphost_service,
		}))
		.filter((h) => h.service);

	const seen = new Set();
	for (const stack of stacks) {
		seen.add(stack.id);
		if (isBusy(stack.id)) continue;
		try {
			const list = await scanStack(
				stack,
				containers.filter((c) => c.stack_id === stack.id),
				hosts.filter((h) => h.stack_id === stack.id),
			);
			await audit(stack, list);
			state.set(stack.id, { findings: list, checked_on: new Date().toISOString() });
		} catch (err) {
			logger.warn(`Drift scan of ${stack.name} failed: ${err.message}`);
		}
	}
	for (const id of state.keys()) {
		if (!seen.has(id)) state.delete(id);
	}
};

const internalDrift = {
	/**
	 * Run a scan now; concurrent requests collapse into one follow-up scan.
	 * @returns {Promise<void>}
	 */
	scan: () => {
		if (scanning) {
			rescanQueued = true;
			return scanning;
		}
		scanning = scanAll()
			.catch((err) => logger.warn(`Drift scan failed: ${err.message}`))
			.finally(() => {
				scanning = null;
				if (rescanQueued) {
					rescanQueued = false;
					internalDrift.scan();
				}
			});
		return scanning;
	},

	/**
	 * @param   {Number} stackId
	 * @returns {{findings: Array, checked_on: string|null}}
	 */
	forStack: (stackId) => state.get(stackId) ?? { findings: [], checked_on: null },

	/**
	 * Problems tied to one host (info-level findings excluded).
	 * @param   {string} kind  proxy | stream
	 * @param   {Number} hostId
	 * @param   {Number} stackId
	 * @returns {Array}
	 */
	forHost: (kind, hostId, stackId) =>
		internalDrift
			.forStack(stackId)
			.findings.filter((f) => f.kind === kind && f.host_id === hostId && f.level !== "info")
			.map(({ code, message, repaired, repaired_on }) => ({ code, message, repaired: !!repaired, repaired_on })),

	/**
	 * Number of findings that need a person (not info, not already repaired).
	 * @param   {Number} stackId
	 * @returns {Number}
	 */
	openCount: (stackId) =>
		internalDrift.forStack(stackId).findings.filter((f) => f.level !== "info" && !f.repaired).length,

	/**
	 * Accept the compose file as it is now as the new baseline.
	 * @param   {Access} access
	 * @param   {Number} stackId
	 * @returns {Promise<Object>}
	 */
	accept: async (access, stackId) => {
		await access.can("stacks:update", stackId);
		const stack = await internalStack.get(access, { id: stackId });
		const hash = internalStack.composeFileHash(stack);
		await stackModel.query().where("id", stack.id).patch({ compose_hash: hash });
		await internalAuditLog.add(access, {
			action: "drift-accepted",
			object_type: "stack",
			object_id: stack.id,
			meta: { name: stack.name },
		});
		await internalDrift.scan();
		return internalDrift.forStack(stack.id);
	},

	/** Start the tick and the docker events watch. */
	initWatch: () => {
		setInterval(() => internalDrift.scan(), TICK_MS);
		const rescanSoon = () => {
			clearTimeout(debounce);
			debounce = setTimeout(() => internalDrift.scan(), EVENT_DEBOUNCE_MS);
		};
		const follow = () => {
			const child = orchestrator.watchEvents((e) => {
				const attrs = e?.Actor?.Attributes || {};
				const relevant =
					e.Type === "network" ? attrs.name === COMPHOST_NETWORK : !!attrs["com.docker.compose.project"];
				if (relevant) rescanSoon();
			});
			child.on("close", () => setTimeout(follow, EVENTS_RESTART_MS));
		};
		follow();
		internalDrift.scan();
		logger.info("Drift watch started (2m tick + docker events)");
	},
};

export default internalDrift;
