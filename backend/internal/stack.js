import fs from "node:fs";
import path from "node:path";
import _ from "lodash";
import errs from "../lib/error.js";
import utils from "../lib/utils.js";
import stackModel from "../models/stack.js";
import proxyHostModel from "../models/proxy_host.js";
import streamModel from "../models/stream.js";
import { CREATED_FILE, composeStackNameRegex, statusConvert, statusFromStates, UNKNOWN } from "../lib/compose/constants.js";
import orchestrator from "../lib/compose/orchestrator.js";
import internalAccessList from "./access-list.js";
import internalAuditLog from "./audit-log.js";
import internalBackup from "./backup.js";
import internalCertificate from "./certificate.js";
import internalCloudflare from "./cloudflare.js";
import internalProxyHost from "./proxy-host.js";
import internalStream from "./stream.js";

const omissions = () => ["is_deleted", "owner.is_deleted"];

// Shared docker network CompHost proxies over. Each exposed
// service is attached to it with a DNS alias that nginx resolves at request time.
const COMPHOST_NETWORK = process.env.COMPHOST_NETWORK || "comphost";

/**
 * Build a DNS-safe network alias for a stack's service.
 * @param   {string} stackName
 * @param   {string} service
 * @returns {string}
 */
const makeAlias = (stackName, service) =>
	`${stackName}-${service}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");

/**
 * Aliases the user declared for a service on the comphost network in their
 * compose file, e.g.
 *   services: { web: { networks: { comphost: { aliases: ["my-app"] } } } }
 * Declaring them is optional — CompHost assigns `<stack>-<service>` otherwise —
 * but when present we honour and preserve them.
 * @param   {Object} cfg      parsed `docker compose config` output
 * @param   {string} service
 * @returns {string[]}
 */
const declaredAliases = (cfg, service) => {
	const net = cfg?.services?.[service]?.networks?.[COMPHOST_NETWORK];
	return Array.isArray(net?.aliases) ? net.aliases.filter(Boolean) : [];
};

/**
 * Resolve the on-disk directory for a stack row.
 * @param   {Object} row
 * @returns {string}
 */
const stackPathOf = (row) =>
	// Adopted stacks keep their original directory (see the compose_dir migration);
	// everything else lives at <stacksDir>/<name>.
	row.compose_dir ? row.compose_dir : orchestrator.getStackPath(row.name);

/**
 * Read the compose file content from disk for a stack row.
 * @param   {Object} row
 * @returns {string}
 */
const readComposeContent = (row) => {
	const file = path.join(stackPathOf(row), row.compose_file_name);
	if (fs.existsSync(file)) {
		return fs.readFileSync(file, "utf8");
	}
	return "";
};

/**
 * Write compose content to a stack's directory (creating the dir if needed).
 * @param {Object} row
 * @param {string} content
 */
const writeComposeContent = (row, content) => {
	const dir = stackPathOf(row);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, row.compose_file_name), content, "utf8");
};

/**
 * Look up the live status of every stack from `docker compose ls` and return a
 * map of stackName -> statusCode. Falls back to an empty map on any error so a
 * broken daemon never takes the API down.
 * @returns {Promise<Object<string, number>>}
 */
/**
 * Services a stack excludes from its status — one-shot init/migration containers
 * that exit 0 by design and would otherwise leave the stack reading Partial
 * forever. Stored per stack; see setIgnoredServices.
 * @param   {Object} row
 * @returns {string[]}
 */
const ignoredServicesOf = (row) => (Array.isArray(row?.meta?.ignore_services) ? row.meta.ignore_services : []);

/**
 * Recompute a stack's status from its individual containers, skipping ignored
 * services. Only called for stacks that actually have an ignore list.
 *
 * @param   {Object} row
 * @param   {Array}  states   from orchestrator.containerStates()
 * @param   {string} project  compose project name for this stack
 * @returns {{code: number, text: string}|null}
 */
const statusIgnoring = (row, states, project) => {
	const ignored = new Set(ignoredServicesOf(row));
	const mine = states.filter((s) => s.project === project);
	if (!mine.length) {
		return null;
	}
	const counted = mine.filter((s) => !ignored.has(s.service));
	if (!counted.length) {
		// Everything is ignored — report on the stack as a whole rather than
		// claiming Unknown, which would be less informative than the truth.
		return null;
	}
	const skipped = mine.length - counted.length;
	const summary = counted.map((s) => `${s.service}:${s.state}`).join(", ");
	return {
		code: statusFromStates(counted.map((s) => s.state)),
		text: skipped ? `${summary} (${skipped} ignored)` : summary,
	};
};

const liveStatusMap = async () => {
	try {
		const list = await orchestrator.composeLs();
		const map = {};
		for (const item of list) {
			if (!item?.Name) {
				continue;
			}
			// Keep compose's own wording alongside the code so the UI can explain
			// a Partial/Exited badge ("exited(1), running(2)") without guessing.
			const entry = { code: statusConvert(item.Status || ""), text: item.Status || "", project: item.Name };
			map[item.Name] = entry;
			// Also key by compose file path. We never pass -p, so compose derives the
			// project name from the directory — for an adopted stack that can differ
			// from the name it was given here, and a name-only lookup would miss and
			// fall back to a stale stored status.
			for (const file of String(item.ConfigFiles || "").split(",")) {
				const trimmed = file.trim();
				if (trimmed) {
					map[path.normalize(trimmed)] = entry;
				}
			}
		}
		return map;
	} catch (_err) {
		return {};
	}
};

/**
 * Live status for a stack row, matched on its compose file first (authoritative)
 * and its name second.
 * @param   {Object} row
 * @param   {Object} statuses  from liveStatusMap()
 * @returns {{code: number, text: string}|null}
 */
const liveStatusOf = (row, statuses) => {
	const file = path.normalize(path.join(stackPathOf(row), row.compose_file_name));
	return statuses[file] ?? statuses[row.name] ?? null;
};

/**
 * Per-container states, but only when some stack actually needs them — the extra
 * docker call is pointless if nothing has an ignore list.
 * @param   {Array} rows
 * @returns {Promise<Array|null>}
 */
const containerStatesIfNeeded = async (rows) => {
	if (!rows.some((row) => ignoredServicesOf(row).length)) {
		return null;
	}
	try {
		return await orchestrator.containerStates();
	} catch (_err) {
		return null;
	}
};

/**
 * Live status for a row, honouring its ignored services when it has any.
 * @param   {Object} row
 * @param   {Object} statuses
 * @param   {Array|null} states
 * @returns {{code: number, text: string}|null}
 */
const resolveStatus = (row, statuses, states) => {
	const live = liveStatusOf(row, statuses);
	if (!live) {
		return null;
	}
	if (states && ignoredServicesOf(row).length) {
		const filtered = statusIgnoring(row, states, live.project);
		if (filtered) {
			return filtered;
		}
	}
	return live;
};


/**
 * Ask compose to parse a stack directory. Returns null when valid, otherwise the
 * parser message — used to reject bad YAML at save time instead of at deploy.
 * @param   {string} dir
 * @returns {Promise<string|null>}
 */
const validateComposeDir = async (dir) => {
	const res = await orchestrator.run(orchestrator.getComposeOptions(dir, orchestrator.getStacksDir(), "config", "-q"), {
		cwd: dir,
	});
	if (res.exitCode === 0) {
		return null;
	}
	const msg = (res.stderr || res.stdout || "compose could not parse this file").trim();
	return msg.split(/\r?\n/)[0];
};

const internalStack = {
	/**
	 * @param   {Access} access
	 * @param   {Object} data   { name, compose_content, compose_file_name? }
	 * @returns {Promise<Object>}
	 */
	create: (access, data) => {
		return access
			.can("stacks:create", data)
			.then(() => {
				const name = (data.name || "").trim();
				if (!composeStackNameRegex.test(name)) {
					throw new errs.ValidationError(
						"Stack name may only contain lowercase letters, numbers, hyphens and underscores",
					);
				}
				if (!data.compose_content) {
					throw new errs.ValidationError("A compose file is required");
				}

				// Reject duplicates (DB row or an existing directory on disk).
				return stackModel
					.query()
					.where("is_deleted", 0)
					.andWhere("name", name)
					.first()
					.then(async (existing) => {
						if (existing || fs.existsSync(orchestrator.getStackPath(name))) {
							throw new errs.ValidationError(`A stack named "${name}" already exists`);
						}

						const row = {
							name,
							compose_file_name: data.compose_file_name || "compose.yaml",
							status: CREATED_FILE,
							owner_user_id: access.token.getUserId(1),
							meta: {},
						};

						// Write the compose file to disk (filesystem is source of truth),
						// then let compose itself validate it — a typo should fail here
						// with a real parser message, not later at deploy time.
						writeComposeContent(row, data.compose_content);
						const problem = await validateComposeDir(stackPathOf(row));
						if (problem) {
							fs.rmSync(stackPathOf(row), { recursive: true, force: true });
							throw new errs.ValidationError(`Invalid compose file: ${problem}`);
						}

						return stackModel.query().insertAndFetch(row).then(utils.omitRow(omissions()));
					});
			})
			.then((row) => {
				return internalAuditLog
					.add(access, {
						action: "created",
						object_type: "stack",
						object_id: row.id,
						meta: _.omit(row, omissions()),
					})
					.then(() => internalStack.get(access, { id: row.id }));
			});
	},

	/**
	 * @param   {Access} access
	 * @param   {Object} data   { id, compose_content?, compose_file_name? }
	 * @returns {Promise<Object>}
	 */
	update: (access, data) => {
		return access
			.can("stacks:update", data.id)
			.then(() => internalStack.get(access, { id: data.id }))
			.then(async (row) => {
				if (!row?.id) {
					throw new errs.ItemNotFoundError(data.id);
				}

				const patch = {};
				if (typeof data.compose_file_name !== "undefined") {
					patch.compose_file_name = data.compose_file_name;
				}

				// Persist compose content to disk if provided, validating first so a
				// broken edit can't silently replace a working stack definition.
				if (typeof data.compose_content !== "undefined") {
					const target = { ...row, ...patch };
					const previous = readComposeContent(target);
					writeComposeContent(target, data.compose_content);
					const problem = await validateComposeDir(stackPathOf(target));
					if (problem) {
						writeComposeContent(target, previous); // roll back the bad edit
						throw new errs.ValidationError(`Invalid compose file: ${problem}`);
					}
				}

				return stackModel
					.query()
					.where("id", row.id)
					.patch(patch)
					.then(() => internalStack.get(access, { id: row.id }));
			})
			.then((row) => {
				return internalAuditLog
					.add(access, {
						action: "updated",
						object_type: "stack",
						object_id: row.id,
						meta: _.omit(row, omissions()),
					})
					.then(() => row);
			});
	},

	/**
	 * @param   {Access} access
	 * @param   {Object} data   { id, expand?, omit? }
	 * @returns {Promise<Object>}
	 */
	get: (access, data) => {
		const thisData = data || {};
		return access
			.can("stacks:get", thisData.id)
			.then((access_data) => {
				const query = stackModel
					.query()
					.where("is_deleted", 0)
					.andWhere("id", thisData.id)
					.allowGraph(stackModel.defaultAllowGraph)
					.first();

				if (access_data.permission_visibility !== "all") {
					query.andWhere("owner_user_id", access.token.getUserId(1));
				}

				if (typeof thisData.expand !== "undefined" && thisData.expand !== null) {
					query.withGraphFetched(`[${thisData.expand.join(", ")}]`);
				}

				return query.then(utils.omitRow(omissions()));
			})
			.then(async (row) => {
				if (!row?.id) {
					throw new errs.ItemNotFoundError(thisData.id);
				}
				// Enrich with live status + on-disk compose content.
				const statuses = await liveStatusMap();
				const live = resolveStatus(row, statuses, await containerStatesIfNeeded([row]));
				row.status = live?.code ?? row.status ?? UNKNOWN;
				row.status_text = live?.text ?? null;
				row.ignore_services = ignoredServicesOf(row);
				row.compose_content = readComposeContent(row);
				row.exposures = await internalStack.listExposures(row.id);

				if (typeof thisData.omit !== "undefined" && thisData.omit !== null) {
					return _.omit(row, thisData.omit);
				}
				return row;
			});
	},

	/**
	 * @param   {Access}  access
	 * @param   {Array}   [expand]
	 * @param   {String}  [searchQuery]
	 * @returns {Promise<Array>}
	 */
	getAll: (access, expand, searchQuery) => {
		return access
			.can("stacks:list")
			.then((access_data) => {
				const query = stackModel
					.query()
					.where("is_deleted", 0)
					.groupBy("id")
					.allowGraph(stackModel.defaultAllowGraph)
					.orderBy("name", "ASC");

				if (access_data.permission_visibility !== "all") {
					query.andWhere("owner_user_id", access.token.getUserId(1));
				}

				if (typeof searchQuery === "string" && searchQuery.length > 0) {
					query.where((builder) => {
						builder.where("name", "like", `%${searchQuery}%`);
					});
				}

				if (typeof expand !== "undefined" && expand !== null) {
					query.withGraphFetched(`[${expand.join(", ")}]`);
				}

				return query.then(utils.omitRows(omissions()));
			})
			.then(async (rows) => {
				// Enrich every row with live status in one `compose ls` call.
				const statuses = await liveStatusMap();
				const states = await containerStatesIfNeeded(rows);
				for (const row of rows) {
					const live = resolveStatus(row, statuses, states);
					row.status = live?.code ?? row.status ?? UNKNOWN;
					row.status_text = live?.text ?? null;
					row.ignore_services = ignoredServicesOf(row);
					// Domains this stack serves + the last cached update count, so the
					// list can show both without a per-row registry round trip.
					row.exposures = await internalStack.listExposures(row.id);
					row.update_count = row.meta?.update_count ?? null;
					row.update_checked_on = row.meta?.update_checked_on ?? null;
				}
				return rows;
			});
	},

	/**
	 * @param   {Access} access
	 * @param   {Object} data   { id }
	 * @returns {Promise<Boolean>}
	 */
	delete: (access, data) => {
		return access
			.can("stacks:delete", data.id)
			.then(() => internalStack.get(access, { id: data.id }))
			.then(async (row) => {
				if (!row?.id) {
					throw new errs.ItemNotFoundError(data.id);
				}

				// Remove anything CompHost created FOR this stack first, otherwise the
				// auto-created proxy hosts linger pointing at an alias that no longer
				// resolves (and keep serving 502s).
				const hosts = await proxyHostModel.query().where("is_deleted", 0).andWhere("stack_id", row.id);
				for (const host of hosts) {
					await internalProxyHost.delete(access, { id: host.id }).catch(() => null);
				}
				const streams = await streamModel.query().where("is_deleted", 0).andWhere("stack_id", row.id);
				for (const stream of streams) {
					await internalStream.delete(access, { id: stream.id }).catch(() => null);
				}

				// Best-effort tear-down before removing files.
				const dir = stackPathOf(row);
				if (orchestrator.findComposeFile(dir)) {
					await orchestrator.downRemoveOrphans(dir).catch(() => null);
				}
				// Never delete an adopted stack's directory — we don't own it.
				if (!row.compose_dir) {
					fs.rmSync(dir, { recursive: true, force: true });
				}

				return stackModel
					.query()
					.where("id", row.id)
					.patch({ is_deleted: 1 })
					.then(() =>
						internalAuditLog.add(access, {
							action: "deleted",
							object_type: "stack",
							object_id: row.id,
							meta: _.omit(row, omissions()),
						}),
					);
			})
			.then(() => true);
	},

	// --- Lifecycle actions --------------------------------------------------

	/**
	 * Run a compose lifecycle op against a stack, refresh its cached status, and
	 * audit it. `op` is one of the orchestrator lifecycle wrappers.
	 * @param   {Access}   access
	 * @param   {Number}   id
	 * @param   {Function} op       orchestrator fn (stackPath, opts) => Promise
	 * @param   {String}   action   audit-log action label
	 * @param   {Function} [onData] optional live-output callback (streaming)
	 * @returns {Promise<Object>}   { exitCode, stdout, stderr, stack }
	 */
	runLifecycle: (access, id, op, action, onData) => {
		return access
			.can("stacks:update", id)
			.then(() => internalStack.get(access, { id }))
			.then(async (row) => {
				if (!row?.id) {
					throw new errs.ItemNotFoundError(id);
				}
				const dir = stackPathOf(row);
				if (!orchestrator.findComposeFile(dir)) {
					throw new errs.ValidationError("Stack has no compose file on disk");
				}

				const result = await op(dir, onData ? { onData } : {});

				// After an `up`-type op the containers may have been recreated, which
				// drops their comphost network attachment — re-attach any exposures.
				if (["deployed", "updated", "restarted"].includes(action)) {
					await internalStack.reattachExposures(row).catch(() => null);
				}

				// Refresh cached status from the daemon.
				const statuses = await liveStatusMap();
				const status = resolveStatus(row, statuses, await containerStatesIfNeeded([row]))?.code ?? UNKNOWN;
				await stackModel.query().where("id", row.id).patch({ status });

				await internalAuditLog.add(access, {
					action,
					object_type: "stack",
					object_id: row.id,
					meta: { name: row.name, exit_code: result.exitCode },
				});

				const stack = await internalStack.get(access, { id: row.id });
				return { ...result, stack };
			});
	},

	/**
	 * Resolve a stack (with access check) and return a live `compose logs -f`
	 * ChildProcess for streaming. Caller must kill it on client disconnect.
	 * @param   {Access} access
	 * @param   {Number} id
	 * @returns {Promise<{child: import("node:child_process").ChildProcess, name: string}>}
	 */
	logStream: (access, id) => {
		return internalStack.get(access, { id }).then(async (row) => {
			if (!row?.id) {
				throw new errs.ItemNotFoundError(id);
			}
			const dir = stackPathOf(row);
			if (!orchestrator.findComposeFile(dir)) {
				throw new errs.ValidationError("Stack has no compose file on disk");
			}
			await internalAuditLog
				.add(access, { action: "viewed-logs", object_type: "stack", object_id: row.id, meta: { name: row.name } })
				.catch(() => null);
			const child = orchestrator.spawnCompose(dir, orchestrator.getStacksDir(), "logs", "-f", "--tail", "200");
			return { child, name: row.name };
		});
	},

	/**
	 * Resolve a stack + service (with access check) for an interactive exec
	 * terminal. Returns the info the WS layer needs to spawn the pty.
	 * @param   {Access} access
	 * @param   {Number} id
	 * @param   {String} service
	 * @returns {Promise<{dir: string, stacksDir: string, service: string, name: string}>}
	 */
	execTarget: (access, id, service) => {
		return access.can("stacks:update", id).then(() =>
			internalStack.get(access, { id }).then(async (row) => {
				if (!row?.id) {
					throw new errs.ItemNotFoundError(id);
				}
				const dir = stackPathOf(row);
				if (!orchestrator.findComposeFile(dir)) {
					throw new errs.ValidationError("Stack has no compose file on disk");
				}
				// Shell access is the most sensitive thing in the product — always
				// leave a trail, even though the session itself isn't recorded.
				await internalAuditLog
					.add(access, {
						action: "opened-shell",
						object_type: "stack",
						object_id: row.id,
						meta: { name: row.name, service },
					})
					.catch(() => null);
				return { dir, stacksDir: orchestrator.getStacksDir(), service, name: row.name };
			}),
		);
	},

	/**
	 * List the services of a stack (name + state) from `docker compose ps`.
	 * @param   {Access} access
	 * @param   {Number} id
	 * @returns {Promise<Array<{name: string, state: string}>>}
	 */
	services: (access, id) => {
		return internalStack.get(access, { id }).then(async (row) => {
			if (!row?.id) {
				throw new errs.ItemNotFoundError(id);
			}
			const dir = stackPathOf(row);
			if (!orchestrator.findComposeFile(dir)) {
				return [];
			}
			// Merge running state (compose ps) with declared ports (compose config)
			// and, as a fallback, ports/aliases discovered from the live container.
			const byName = {};
			const containerIds = {};
			try {
				const ps = await orchestrator.composePs(dir);
				for (const s of ps) {
					byName[s.Service] = { name: s.Service, state: s.State, ports: [], aliases: [] };
					if (s.ID) {
						containerIds[s.Service] = s.ID;
					}
				}
			} catch (_err) {
				// daemon issue — fall through to config-only
			}
			try {
				const cfg = await orchestrator.composeConfig(dir);
				const svcs = cfg?.services || {};
				for (const [name, def] of Object.entries(svcs)) {
					if (!byName[name]) {
						byName[name] = { name, state: "not created", ports: [], aliases: [] };
					}
					// Collect candidate container ports from the compose `ports` + `expose`.
					const ports = new Set();
					for (const p of def.ports || []) {
						const target = typeof p === "object" ? p.target : String(p).split(":").pop().split("/")[0];
						if (target) ports.add(Number.parseInt(target, 10));
					}
					for (const e of def.expose || []) {
						ports.add(Number.parseInt(String(e).split("/")[0], 10));
					}
					byName[name].ports = [...ports].filter((n) => !Number.isNaN(n));
					// Aliases the user declared for the comphost network (optional).
					byName[name].aliases = declaredAliases(cfg, name);
				}
			} catch (_err) {
				// config parse issue — return state-only
			}

			// Fallback: for running services with no declared ports, use the ports the
			// image itself exposes — so the UI can prefill without the user knowing them.
			for (const svc of Object.values(byName)) {
				if (svc.ports.length === 0 && containerIds[svc.name]) {
					const info = await orchestrator.inspectContainer(containerIds[svc.name]).catch(() => null);
					if (info?.ports?.length) {
						svc.ports = info.ports;
					}
				}
				// Suggest the alias CompHost would use, so the UI can show the target.
				svc.suggestedAlias = svc.aliases[0] || makeAlias(row.name, svc.name);
			}
			return Object.values(byName);
		});
	},

	/**
	 * Re-attach a stack's exposed services to the comphost network (after a
	 * deploy/redeploy that recreated the containers). Best-effort.
	 * @param {Object} row  stack row
	 */
	reattachExposures: async (row) => {
		const hosts = await proxyHostModel.query().where("is_deleted", 0).andWhere("stack_id", row.id);
		if (!hosts.length) {
			return;
		}
		await orchestrator.ensureNetwork(COMPHOST_NETWORK);
		const dir = stackPathOf(row);
		const cfg = await orchestrator.composeConfig(dir).catch(() => null);
		for (const host of hosts) {
			const service = host.meta?.comphost_service;
			if (!service) continue;
			const cid = await orchestrator.getServiceContainerId(dir, service).catch(() => null);
			if (cid) {
				// Keep the proxy target alias AND any the user declared in compose.
				const aliases = [...new Set([host.forward_host, ...declaredAliases(cfg, service)])];
				await orchestrator.connectContainerToNetwork(cid, COMPHOST_NETWORK, aliases).catch(() => null);
			}
		}
	},

	/**
	 * Expose a stack's service as a proxy host over the comphost network.
	 * @param   {Access} access
	 * @param   {Object} data  { id, service, port, domain_names[], forward_scheme?,
	 *                           ssl_forced?, certificate?, certificate_id?,
	 *                           cloudflare?, basic_auth?, alias? }
	 * @param   {Function} [onProgress] step messages for the streaming endpoint
	 * @returns {Promise<Object>} the created proxy host
	 */
	expose: (access, data, onProgress) => {
		const progress = (msg) => onProgress?.(msg);
		return access
			.can("stacks:update", data.id)
			.then(() => internalStack.get(access, { id: data.id }))
			.then(async (row) => {
				if (!row?.id) {
					throw new errs.ItemNotFoundError(data.id);
				}
				if (!data.service || !data.port) {
					throw new errs.ValidationError("service and port are required");
				}
				if (!Array.isArray(data.domain_names) || data.domain_names.length === 0) {
					throw new errs.ValidationError("At least one domain name is required");
				}

				const dir = stackPathOf(row);

				// Alias precedence: explicit request > one the user declared for the
				// comphost network in their compose > generated <stack>-<service>.
				// Declaring aliases is optional; when present we keep ALL of them so a
				// reconnect never clobbers the user's own names.
				const cfg = await orchestrator.composeConfig(dir).catch(() => null);
				const declared = declaredAliases(cfg, data.service);
				const alias = data.alias || declared[0] || makeAlias(row.name, data.service);
				const allAliases = [...new Set([alias, ...declared])];

				// Ensure the shared network exists and attach the running container.
				await orchestrator.ensureNetwork(COMPHOST_NETWORK);
				const cid = await orchestrator.getServiceContainerId(dir, data.service);
				if (!cid) {
					throw new errs.ValidationError(
						`Service "${data.service}" is not running — deploy the stack first`,
					);
				}
				progress(`Attaching ${data.service} to the ${COMPHOST_NETWORK} network as "${alias}"…`);
				await orchestrator.connectContainerToNetwork(cid, COMPHOST_NETWORK, allAliases);

				// Optional: point DNS at this server via Cloudflare (before the cert so
				// the record can propagate while ACME validates).
				let dns = null;
				if (data.cloudflare) {
					for (const domain of data.domain_names) {
						progress(`Pointing DNS for ${domain} at this server via Cloudflare…`);
						dns = await internalCloudflare.pointDomain(domain);
						progress(`  → A record ${dns.name} = ${dns.content} (zone ${dns.zone})`);
					}
				}

				// Optional: certificate — "new" requests a Let's Encrypt cert (HTTP-01),
				// a number uses an existing cert, anything else = none (plain HTTP).
				let certificateId = 0;
				if (data.certificate === "new") {
					progress(
						`Requesting a Let's Encrypt certificate for ${data.domain_names.join(", ")} — this can take 30s or more…`,
					);
					const cert = await internalCertificate.create(access, {
						provider: "letsencrypt",
						nice_name: `${row.name} (${data.service})`,
						domain_names: data.domain_names,
						meta: { letsencrypt_agree: true, dns_challenge: false, key_type: "ecdsa" },
					});
					certificateId = cert.id;
					progress(`  → certificate #${cert.id} issued`);
				} else if (Number.parseInt(data.certificate_id, 10) > 0) {
					certificateId = Number.parseInt(data.certificate_id, 10);
				}
				const sslForced = certificateId > 0 && data.ssl_forced !== false;

				// Optional: basic auth — inline {username,password} creates an access list,
				// or use an existing access_list_id.
				let accessListId = Number.parseInt(data.access_list_id, 10) || 0;
				if (data.basic_auth?.username && data.basic_auth?.password) {
					progress(`Creating basic-auth access list for user "${data.basic_auth.username}"…`);
					const list = await internalAccessList.create(access, {
						name: `${row.name}-${data.service}`,
						satisfy_any: false,
						pass_auth: false,
						items: [{ username: data.basic_auth.username, password: data.basic_auth.password }],
						clients: [],
						meta: {},
					});
					accessListId = list.id;
				}

				// Create the proxy host pointing at the alias over comphost.
				const proxyData = {
					domain_names: data.domain_names,
					forward_scheme: data.forward_scheme || "http",
					forward_host: alias,
					forward_port: Number.parseInt(data.port, 10),
					access_list_id: accessListId,
					certificate_id: certificateId,
					ssl_forced: sslForced,
					caching_enabled: false,
					block_exploits: true,
					allow_websocket_upgrade: true,
					http2_support: certificateId > 0,
					hsts_enabled: false,
					hsts_subdomains: false,
					advanced_config: "",
					locations: [],
					meta: { comphost_service: data.service, comphost_stack_id: row.id },
					stack_id: row.id,
				};
				progress(`Creating proxy host ${data.domain_names.join(", ")} → ${alias}:${data.port}…`);
				const proxyHost = await internalProxyHost.create(access, proxyData);
				progress(
					`✓ Exposed at ${certificateId > 0 ? "https" : "http"}://${data.domain_names[0]} (proxy host #${proxyHost.id})`,
				);

				await internalAuditLog.add(access, {
					action: "exposed",
					object_type: "stack",
					object_id: row.id,
					meta: {
						name: row.name,
						service: data.service,
						alias,
						port: data.port,
						domains: data.domain_names,
						dns,
						certificate_id: certificateId,
						access_list_id: accessListId,
					},
				});

				return proxyHost;
			});
	},

	/**
	 * What a stack is currently published as: proxy hosts (domains) and stream
	 * hosts (ports) CompHost created for it.
	 * @param   {Number} stackId
	 * @returns {Promise<Array<Object>>}
	 */
	listExposures: async (stackId) => {
		const hosts = await proxyHostModel.query().where("is_deleted", 0).andWhere("stack_id", stackId);
		const streams = await streamModel.query().where("is_deleted", 0).andWhere("stack_id", stackId);
		return [
			...hosts.map((h) => ({
				type: "proxy",
				id: h.id,
				service: h.meta?.comphost_service || null,
				domains: h.domain_names || [],
				target: `${h.forward_host}:${h.forward_port}`,
				ssl: !!h.certificate_id,
			})),
			...streams.map((s) => ({
				type: "stream",
				id: s.id,
				service: s.meta?.comphost_service || null,
				incomingPort: s.incoming_port,
				target: `${s.forwarding_host}:${s.forwarding_port}`,
				protocols: [s.tcp_forwarding ? "TCP" : null, s.udp_forwarding ? "UDP" : null].filter(Boolean),
			})),
		];
	},

	/**
	 * Read a stack's .env plus the variables its compose file actually references,
	 * so the editor can show what's expected rather than a blank box.
	 * @param   {Access} access
	 * @param   {Number} id
	 * @returns {Promise<{content: string, variables: Array<Object>}>}
	 */
	getEnv: (access, id) => {
		return internalStack.get(access, { id }).then((row) => {
			if (!row?.id) {
				throw new errs.ItemNotFoundError(id);
			}
			const envFile = path.join(stackPathOf(row), ".env");
			const content = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";

			// Values currently set in .env.
			const set = {};
			for (const line of content.split(/\r?\n/)) {
				const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
				if (m) set[m[1]] = m[2];
			}

			// Variables the RAW compose references — ${VAR}, ${VAR:-default}, $VAR.
			// (Read raw, not `compose config`, which has already interpolated them.)
			const raw = readComposeContent(row);
			const referenced = new Map();
			for (const m of raw.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/g)) {
				referenced.set(m[1], m[2] ?? "");
			}
			for (const m of raw.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
				if (!referenced.has(m[1])) referenced.set(m[1], "");
			}

			const names = new Set([...referenced.keys(), ...Object.keys(set)]);
			const variables = [...names].sort().map((name) => ({
				name,
				value: set[name] ?? "",
				// Referenced by compose but absent from .env → compose will use the
				// default (or empty), which is usually what the user wants flagged.
				usedInCompose: referenced.has(name),
				defaultValue: referenced.get(name) ?? "",
				missing: referenced.has(name) && !(name in set),
			}));
			return { content, variables };
		});
	},

	/**
	 * Write a stack's .env, either as raw content or as key/value pairs.
	 * @param   {Access} access
	 * @param   {Number} id
	 * @param   {Object} data  { content? , variables?: [{name, value}] }
	 */
	setEnv: (access, id, data) => {
		return access
			.can("stacks:update", id)
			.then(() => internalStack.get(access, { id }))
			.then(async (row) => {
				if (!row?.id) {
					throw new errs.ItemNotFoundError(id);
				}
				let content = data.content;
				if (content === undefined && Array.isArray(data.variables)) {
					const vars = data.variables.filter((v) => v.name);
					for (const v of vars) {
						// A bad name or a newline in a value would write lines compose
						// either ignores or misreads, so reject instead of corrupting .env.
						if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name)) {
							throw new errs.ValidationError(`Invalid variable name: ${v.name}`);
						}
						if (/[\r\n]/.test(v.value ?? "")) {
							throw new errs.ValidationError(`Value for ${v.name} must not contain line breaks`);
						}
					}
					content = `${vars.map((v) => `${v.name}=${v.value ?? ""}`).join("\n")}\n`;
				}
				const dir = stackPathOf(row);
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(path.join(dir, ".env"), content ?? "", "utf8");
				await internalAuditLog.add(access, {
					action: "updated",
					object_type: "stack",
					object_id: row.id,
					meta: { name: row.name, env: true },
				});
				return internalStack.getEnv(access, id);
			});
	},

	/**
	 * Expose a stack service as a TCP/UDP stream (non-HTTP: game servers, DBs...).
	 * Same comphost-network mechanism as expose(), but creates an NPM stream host.
	 * @param   {Access} access
	 * @param   {Object} data  { id, service, port, incoming_port, tcp?, udp? }
	 */
	exposeStream: (access, data) => {
		return access
			.can("stacks:update", data.id)
			.then(() => internalStack.get(access, { id: data.id }))
			.then(async (row) => {
				if (!row?.id) {
					throw new errs.ItemNotFoundError(data.id);
				}
				if (!data.service || !data.port || !data.incoming_port) {
					throw new errs.ValidationError("service, port and incoming_port are required");
				}
				const dir = stackPathOf(row);
				const cfg = await orchestrator.composeConfig(dir).catch(() => null);
				const declared = declaredAliases(cfg, data.service);
				const alias = data.alias || declared[0] || makeAlias(row.name, data.service);

				await orchestrator.ensureNetwork(COMPHOST_NETWORK);
				const cid = await orchestrator.getServiceContainerId(dir, data.service);
				if (!cid) {
					throw new errs.ValidationError(`Service "${data.service}" is not running — deploy the stack first`);
				}
				await orchestrator.connectContainerToNetwork(cid, COMPHOST_NETWORK, [...new Set([alias, ...declared])]);

				const stream = await internalStream.create(access, {
					incoming_port: Number.parseInt(data.incoming_port, 10),
					forwarding_host: alias,
					forwarding_port: Number.parseInt(data.port, 10),
					tcp_forwarding: data.tcp !== false,
					udp_forwarding: !!data.udp,
					certificate_id: 0,
					meta: { comphost_service: data.service, comphost_stack_id: row.id },
					stack_id: row.id,
				});

				await internalAuditLog.add(access, {
					action: "exposed",
					object_type: "stack",
					object_id: row.id,
					meta: { name: row.name, service: data.service, alias, stream: true, port: data.incoming_port },
				});
				return stream;
			});
	},

	/**
	 * Compose projects on this host that CompHost doesn't manage yet — the list
	 * offered for adoption when migrating an existing box.
	 * @param   {Access} access
	 * @returns {Promise<Array<Object>>}
	 */
	discover: async (access) => {
		await access.can("stacks:list");
		const projects = await orchestrator.discoverProjects();
		const known = await stackModel.query().where("is_deleted", 0);
		const knownNames = new Set(known.map((s) => s.name));
		const stacksDir = orchestrator.getStacksDir();
		return projects
			.filter((p) => p.name && !knownNames.has(p.name))
			.map((p) => {
				const dir = p.configFiles[0] ? path.dirname(p.configFiles[0]) : "";
				return {
					name: p.name,
					status: p.status,
					composeDir: dir,
					composeFile: p.configFiles[0] || "",
					// Already in our stacks dir? Then it needs no compose_dir override.
					inStacksDir: dir === orchestrator.getStackPath(p.name, stacksDir),
					// We can only manage it if the compose file is visible to us.
					readable: !!p.configFiles[0] && fs.existsSync(p.configFiles[0]),
				};
			});
	},

	/**
	 * Choose which services are excluded from a stack's status. A one-shot init or
	 * migration container exits 0 by design; without this the stack reads Partial
	 * for as long as it runs.
	 *
	 * @param   {Access}   access
	 * @param   {Number}   id
	 * @param   {String[]} services
	 * @returns {Promise<Object>}
	 */
	setIgnoredServices: (access, id, services) => {
		return access
			.can("stacks:update", id)
			.then(() => internalStack.get(access, { id }))
			.then(async (row) => {
				if (!row?.id) {
					throw new errs.ItemNotFoundError(id);
				}
				const list = [...new Set((services || []).map((s) => String(s).trim()).filter(Boolean))];
				await stackModel
					.query()
					.where("id", row.id)
					.patch({ meta: { ...(row.meta || {}), ignore_services: list } });
				await internalAuditLog.add(access, {
					action: "updated",
					object_type: "stack",
					object_id: row.id,
					meta: { name: row.name, ignore_services: list },
				});
				return internalStack.get(access, { id: row.id });
			});
	},

	/**
	 * Browse directories visible to CompHost, so a compose project that isn't
	 * currently up — and therefore never appears in `docker compose ls` — can
	 * still be located and adopted. Lists directory names only, never file
	 * contents, and flags which ones hold a recognised compose file.
	 * @param   {Access} access
	 * @param   {string} [requested]  absolute path; defaults to the stacks dir
	 * @returns {Promise<Object>}
	 */
	browse: async (access, requested) => {
		await access.can("stacks:create", {});

		const stacksDir = orchestrator.getStacksDir();
		const wanted = (requested || "").trim();
		const dir = path.resolve(wanted || stacksDir);

		let stat;
		try {
			stat = fs.statSync(dir);
		} catch (_err) {
			throw new errs.ValidationError(`No such directory: ${dir}`);
		}
		if (!stat.isDirectory()) {
			throw new errs.ValidationError(`Not a directory: ${dir}`);
		}

		let names;
		try {
			names = fs.readdirSync(dir);
		} catch (_err) {
			throw new errs.ValidationError(`Cannot read ${dir} — check permissions`);
		}

		const known = await stackModel.query().where("is_deleted", 0);
		const knownDirs = new Set(known.map((s) => path.resolve(stackPathOf(s))));

		const MAX = 500;
		const entries = [];
		let truncated = false;
		for (const name of names.sort((a, b) => a.localeCompare(b))) {
			if (entries.length >= MAX) {
				truncated = true;
				break;
			}
			const full = path.join(dir, name);
			try {
				// Directories only — adoption targets a directory, not a loose file.
				if (!fs.statSync(full).isDirectory()) {
					continue;
				}
			} catch (_err) {
				continue; // unreadable, or a dangling symlink
			}
			const composeFile = orchestrator.findComposeFile(full);
			entries.push({
				name,
				path: full,
				compose_file: composeFile ? path.basename(composeFile) : "",
				managed: knownDirs.has(path.resolve(full)),
			});
		}

		const parent = path.dirname(dir);
		const here = orchestrator.findComposeFile(dir);
		return {
			path: dir,
			parent: parent === dir ? null : parent,
			stacks_dir: stacksDir,
			compose_file: here ? path.basename(here) : "",
			managed: knownDirs.has(dir),
			entries,
			truncated,
		};
	},

	/**
	 * Adopt an existing compose project in place: register it as a CompHost stack
	 * without moving any files (moving would break relative bind mounts and
	 * orphan the running project).
	 * @param   {Access} access
	 * @param   {Object} data  { name, compose_dir? }
	 * @returns {Promise<Object>}
	 */
	adopt: (access, data) => {
		return access.can("stacks:create", data).then(async () => {
			const name = (data.name || "").trim();
			if (!composeStackNameRegex.test(name)) {
				throw new errs.ValidationError("Stack name may only contain lowercase letters, numbers, - and _");
			}
			const existing = await stackModel.query().where("is_deleted", 0).andWhere("name", name).first();
			if (existing) {
				throw new errs.ValidationError(`A stack named "${name}" is already managed by CompHost`);
			}

			// Locate the project's compose file, preferring an explicit directory.
			let dir = (data.compose_dir || "").trim();
			if (!dir) {
				const found = (await orchestrator.discoverProjects()).find((p) => p.name === name);
				dir = found?.configFiles?.[0] ? path.dirname(found.configFiles[0]) : "";
			}
			if (!dir) {
				throw new errs.ValidationError(`Could not locate a compose file for project "${name}"`);
			}
			const composeFile = orchestrator.findComposeFile(dir);
			if (!composeFile) {
				throw new errs.ValidationError(
					`No compose file found in ${dir}. If it lives outside CompHost's view, mount that path into the container.`,
				);
			}

			// Default layout needs no override; anything else records its directory.
			const isDefault = dir === orchestrator.getStackPath(name);
			const row = await stackModel
				.query()
				.insertAndFetch({
					name,
					compose_file_name: path.basename(composeFile),
					compose_dir: isDefault ? "" : dir,
					status: UNKNOWN,
					owner_user_id: access.token.getUserId(1),
					meta: { adopted: true, adopted_from: dir },
				})
				.then(utils.omitRow(omissions()));

			await internalAuditLog.add(access, {
				action: "adopted",
				object_type: "stack",
				object_id: row.id,
				meta: { name, dir },
			});
			return internalStack.get(access, { id: row.id });
		});
	},

	/**
	 * Per-service image update check: is the tag pointing at a newer digest than
	 * the one we're running?
	 * @param   {Access} access
	 * @param   {Number} id
	 * @returns {Promise<{updates: Array<Object>, updateCount: number}>}
	 */
	checkUpdates: (access, id) => {
		return internalStack.get(access, { id }).then(async (row) => {
			if (!row?.id) {
				throw new errs.ItemNotFoundError(id);
			}
			const dir = stackPathOf(row);
			const cfg = await orchestrator.composeConfig(dir).catch(() => null);
			const services = cfg?.services || {};
			const results = [];
			for (const [name, def] of Object.entries(services)) {
				if (!def.image) {
					// Locally-built services have nothing to compare against.
					results.push({ service: name, image: null, updateAvailable: false, error: "built locally" });
					continue;
				}
				const res = await orchestrator.checkImageUpdate(def.image).catch((err) => ({
					image: def.image,
					updateAvailable: false,
					error: err.message,
				}));
				results.push({ service: name, ...res });
			}
			const updateCount = results.filter((r) => r.updateAvailable).length;
			// Cache on the row so the Stacks list can badge without hitting registries
			// for every stack on every page load.
			await stackModel
				.query()
				.where("id", row.id)
				.patch({ meta: { ...(row.meta || {}), update_count: updateCount, update_checked_on: new Date().toISOString() } })
				.catch(() => null);
			return { updates: results, updateCount };
		});
	},

	/**
	 * Back up a stack's volumes to a backup target (on-demand).
	 * @param   {Access} access
	 * @param   {Object} data  { id, target_id }
	 * @returns {Promise<Object>}
	 */
	backup: (access, data) => {
		return access
			.can("stacks:update", data.id)
			.then(() => internalStack.get(access, { id: data.id }))
			.then(async (row) => {
				if (!row?.id) {
					throw new errs.ItemNotFoundError(data.id);
				}
				const target = await internalBackup.getTargetRaw(Number.parseInt(data.target_id, 10));
				if (!target) {
					throw new errs.ValidationError("Backup target not found");
				}
				const result = await internalBackup.backupStackVolumes(row, target);
				await internalAuditLog.add(access, {
					action: "backed-up",
					object_type: "stack",
					object_id: row.id,
					meta: { name: row.name, target: target.name, ...result },
				});
				return result;
			});
	},

	// Each accepts an optional onData callback to stream live command output.
	deploy: (access, data, onData) =>
		internalStack.runLifecycle(access, data.id, (dir, o) => orchestrator.up(dir, undefined, o), "deployed", onData),
	down: (access, data, onData) =>
		internalStack.runLifecycle(access, data.id, (dir, o) => orchestrator.down(dir, undefined, o), "downed", onData),
	stop: (access, data, onData) =>
		internalStack.runLifecycle(access, data.id, (dir, o) => orchestrator.stop(dir, undefined, o), "stopped", onData),
	restart: (access, data, onData) =>
		internalStack.runLifecycle(
			access,
			data.id,
			(dir, o) => orchestrator.restart(dir, undefined, o),
			"restarted",
			onData,
		),

	/**
	 * Pull latest images, then (re)deploy.
	 */
	updateStack: (access, data, onData) =>
		internalStack.runLifecycle(
			access,
			data.id,
			async (dir, o) => {
				const pullRes = await orchestrator.pull(dir, undefined, o);
				const upRes = await orchestrator.up(dir, undefined, o);
				return { exitCode: upRes.exitCode, stdout: pullRes.stdout + upRes.stdout, stderr: pullRes.stderr + upRes.stderr };
			},
			"updated",
			onData,
		),
};

export default internalStack;
