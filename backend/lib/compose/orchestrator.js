// Docker Compose orchestration layer.
// Ported (logic) from Dockge (louislam/dockge) backend/stack.ts — MIT licensed —
// but decoupled from socket.io / node-pty. Everything here shells out to the
// `docker compose` CLI via child_process, matching what a user would type.
//
// Two execution styles:
//   - runJson():  one-shot reads (ls/ps), returns parsed JSON.
//   - run():      lifecycle commands (up/down/pull/...), captures output and
//                 resolves {exitCode, stdout, stderr}. Non-zero exit does NOT
//                 throw — a failed `compose up` is a normal signal we surface to
//                 the caller. An optional onData(chunk) callback streams output
//                 live (the seam the future SSE/WebSocket layer plugs into).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { acceptedComposeFileNames } from "./constants.js";

/**
 * Resolve the stacks directory. Mirrors Dockge's DOCKGE_STACKS_DIR.
 * Docker-socket path identity requires this to
 * be identical on host and inside the container.
 * @returns {string}
 */
export const getStacksDir = () => {
	if (process.env.COMPHOST_STACKS_DIR) {
		return process.env.COMPHOST_STACKS_DIR;
	}
	if (process.platform === "win32") {
		// Local dev only; production is always an explicit absolute path.
		return path.join(process.cwd(), "data", "stacks");
	}
	return "/opt/stacks";
};

/**
 * The on-disk path of a named stack.
 * @param   {string} name
 * @param   {string} [stacksDir]
 * @returns {string}
 */
export const getStackPath = (name, stacksDir = getStacksDir()) => path.join(stacksDir, name);

/**
 * Find the compose file inside a stack directory, if any.
 * @param   {string} stackPath
 * @returns {string|null} absolute path to the compose file, or null
 */
export const findComposeFile = (stackPath) => {
	for (const name of acceptedComposeFileNames) {
		const p = path.join(stackPath, name);
		if (fs.existsSync(p)) {
			return p;
		}
	}
	return null;
};

/**
 * Build `docker compose ...` argument list, injecting env-files the way Dockge
 * does: ../global.env (shared) then ./.env (per-stack), when they exist.
 * @param   {string}    stackPath
 * @param   {string}    stacksDir
 * @param   {string}    command      e.g. "up"
 * @param   {...string} extraOptions
 * @returns {string[]}
 */
export const getComposeOptions = (stackPath, stacksDir, command, ...extraOptions) => {
	const options = ["compose", command, ...extraOptions];
	if (fs.existsSync(path.join(stacksDir, "global.env"))) {
		if (fs.existsSync(path.join(stackPath, ".env"))) {
			options.splice(1, 0, "--env-file", "./.env");
		}
		options.splice(1, 0, "--env-file", "../global.env");
	}
	return options;
};

/**
 * Run a docker command, capturing output. Never rejects on a non-zero exit code
 * (that is returned in the result); only rejects if the process cannot spawn.
 * @param   {string[]} args
 * @param   {Object}   [opts]
 * @param   {string}   [opts.cwd]
 * @param   {(chunk: string) => void} [opts.onData]  live output stream hook
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
export const run = (args, opts = {}) =>
	new Promise((resolve, reject) => {
		const child = spawn("docker", args, {
			cwd: opts.cwd,
			// UV_USE_IO_URING=0 mirrors Dockge's node-pty workaround; harmless here
			// and kept so the runtime image behaves consistently.
			env: { ...process.env, UV_USE_IO_URING: "0" },
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (d) => {
			const s = d.toString();
			stdout += s;
			if (opts.onData) {
				opts.onData(s);
			}
		});
		child.stderr.on("data", (d) => {
			const s = d.toString();
			stderr += s;
			if (opts.onData) {
				opts.onData(s);
			}
		});
		child.on("error", (err) => reject(err));
		child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
	});

/**
 * Spawn a docker command and return the live ChildProcess (for streaming, e.g.
 * `compose logs -f`). Caller is responsible for killing it on client disconnect.
 * @param   {string} stackPath
 * @param   {string} stacksDir
 * @param   {string} command
 * @param   {...string} extra
 * @returns {import("node:child_process").ChildProcess}
 */
export const spawnCompose = (stackPath, stacksDir, command, ...extra) =>
	spawn("docker", getComposeOptions(stackPath, stacksDir, command, ...extra), {
		cwd: stackPath,
		env: { ...process.env, UV_USE_IO_URING: "0" },
	});

/**
 * Tolerant parse of docker's `--format json` output, which is a JSON array in
 * some CLI versions and newline-delimited JSON objects in others.
 * @param   {string} out
 * @returns {Array<Object>}
 */
const parseJsonOutput = (out) => {
	const trimmed = (out || "").trim();
	if (!trimmed) {
		return [];
	}
	try {
		const parsed = JSON.parse(trimmed);
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		// NDJSON fallback
		return trimmed
			.split(/\r?\n/)
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));
	}
};

/**
 * `docker compose ls --all --format json` — all stacks known to the daemon.
 * @returns {Promise<Array<Object>>}
 */
export const composeLs = async () => {
	const { stdout } = await run(["compose", "ls", "--all", "--format", "json"]);
	return parseJsonOutput(stdout);
};

/**
 * Per-container state for every compose-managed container on the host, in one
 * call. `compose ls` only gives an aggregate per project ("exited(1), running(1)"),
 * which can't be filtered — this is what lets a stack exclude its one-shot
 * services from its status.
 *
 * @returns {Promise<Array<{project: string, service: string, state: string}>>}
 */
export const containerStates = async () => {
	const { stdout, exitCode } = await run([
		"ps",
		"-a",
		"--filter",
		"label=com.docker.compose.project",
		"--format",
		'{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}',
	]);
	if (exitCode !== 0) {
		return [];
	}
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [project, service, state] = line.split("\t");
			return { project, service, state: (state || "").toLowerCase() };
		})
		.filter((row) => row.project && row.service);
};

/**
 * `docker compose ps --format json` for one stack.
 * @param   {string} stackPath
 * @param   {string} [stacksDir]
 * @returns {Promise<Array<Object>>}
 */
export const composePs = async (stackPath, stacksDir = getStacksDir()) => {
	const { stdout } = await run(getComposeOptions(stackPath, stacksDir, "ps", "--format", "json"), {
		cwd: stackPath,
	});
	return parseJsonOutput(stdout);
};

/**
 * The fully-resolved compose model via `docker compose config --format json`.
 * Authoritative source for services + ports (no YAML parser needed).
 * @param   {string} stackPath
 * @param   {string} [stacksDir]
 * @returns {Promise<Object|null>}
 */
export const composeConfig = async (stackPath, stacksDir = getStacksDir()) => {
	const { stdout, exitCode } = await run(getComposeOptions(stackPath, stacksDir, "config", "--format", "json"), {
		cwd: stackPath,
	});
	if (exitCode !== 0) {
		return null;
	}
	try {
		return JSON.parse(stdout);
	} catch {
		return null;
	}
};

/**
 * Ensure a docker network exists (idempotent). Used for the shared `comphost`
 * network that CompHost proxies over.
 * @param   {string} name
 * @returns {Promise<void>}
 */
export const ensureNetwork = async (name) => {
	const { stdout } = await run(["network", "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"]);
	if (stdout.trim() === name) {
		return;
	}
	await run(["network", "create", name]);
};

/**
 * Resolve the container id for a service of a running stack.
 * @param   {string} stackPath
 * @param   {string} service
 * @param   {string} [stacksDir]
 * @returns {Promise<string|null>}
 */
export const getServiceContainerId = async (stackPath, service, stacksDir = getStacksDir()) => {
	const { stdout, exitCode } = await run(getComposeOptions(stackPath, stacksDir, "ps", "-q", service), {
		cwd: stackPath,
	});
	if (exitCode !== 0) {
		return null;
	}
	return stdout.trim().split(/\r?\n/)[0] || null;
};

/**
 * Attach a running service's container to a network with a stable DNS alias
 * (idempotent — reconnects with the alias even if already attached).
 * @param   {string} containerId
 * @param   {string} network
 * @param   {string} alias
 * @returns {Promise<void>}
 */
export const connectContainerToNetwork = async (containerId, network, aliases) => {
	const list = [...new Set((Array.isArray(aliases) ? aliases : [aliases]).filter(Boolean))];
	// Disconnect first so re-connecting refreshes the alias set; ignore if not connected.
	await run(["network", "disconnect", network, containerId]).catch(() => null);
	const args = ["network", "connect"];
	for (const alias of list) {
		args.push("--alias", alias);
	}
	args.push(network, containerId);
	await run(args);
};

/**
 * Inspect a container: returns its exposed ports and the aliases it currently
 * holds on a given network. Used to discover ports the compose file doesn't
 * declare, and to preserve user-declared network aliases.
 * @param   {string} containerId
 * @param   {string} [network]
 * @returns {Promise<{ports: number[], aliases: string[]}>}
 */
export const inspectContainer = async (containerId, network) => {
	const { stdout, exitCode } = await run(["inspect", containerId, "--format", "json"]);
	if (exitCode !== 0) {
		return { ports: [], aliases: [] };
	}
	try {
		const arr = JSON.parse(stdout);
		const c = Array.isArray(arr) ? arr[0] : arr;
		const ports = Object.keys(c?.Config?.ExposedPorts || {})
			.map((p) => Number.parseInt(String(p).split("/")[0], 10))
			.filter((n) => !Number.isNaN(n));
		const net = network ? c?.NetworkSettings?.Networks?.[network] : null;
		return { ports, aliases: net?.Aliases || [] };
	} catch {
		return { ports: [], aliases: [] };
	}
};

/**
 * Compare a service image's local digest with the registry's, without pulling.
 * Uses the shared DOCKER_CONFIG, so private registries configured in Settings →
 * Registries authenticate automatically.
 * @param   {string} image  e.g. "nginx:alpine"
 * @returns {Promise<{image: string, local: string|null, remote: string|null, updateAvailable: boolean, error?: string}>}
 */
export const checkImageUpdate = async (image) => {
	// Local: the digest we actually pulled (empty for locally-built images).
	const localRes = await run(["image", "inspect", image, "--format", "{{json .RepoDigests}}"]);
	let local = null;
	if (localRes.exitCode === 0) {
		try {
			const digests = JSON.parse(localRes.stdout.trim() || "[]");
			local = (digests[0] || "").split("@")[1] || null;
		} catch {
			// leave null
		}
	}

	// Remote: the manifest the tag currently points at.
	const remoteRes = await run(["manifest", "inspect", "--verbose", image]);
	let remote = null;
	if (remoteRes.exitCode !== 0) {
		return { image, local, remote: null, updateAvailable: false, error: remoteRes.stderr.trim().split("\n")[0] };
	}
	try {
		const parsed = JSON.parse(remoteRes.stdout);
		const first = Array.isArray(parsed) ? parsed[0] : parsed;
		remote = first?.Descriptor?.digest || first?.digest || null;
	} catch {
		// leave null
	}

	return {
		image,
		local,
		remote,
		// Only claim an update when both digests are known and differ — never guess.
		updateAvailable: !!local && !!remote && local !== remote,
	};
};

/**
 * Compose projects the daemon knows about (`docker compose ls --all`), including
 * ones CompHost didn't create — the basis for adopting existing stacks.
 * @returns {Promise<Array<{name: string, status: string, configFiles: string[]}>>}
 */
export const discoverProjects = async () => {
	const list = await composeLs();
	return list.map((p) => ({
		name: p.Name,
		status: p.Status || "",
		configFiles: String(p.ConfigFiles || "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	}));
};

// --- Lifecycle wrappers -----------------------------------------------------
// Each resolves {exitCode, stdout, stderr}. Pass opts.onData to stream output.

const lifecycle =
	(command, ...fixed) =>
	(stackPath, stacksDir = getStacksDir(), opts = {}) =>
		run(getComposeOptions(stackPath, stacksDir, command, ...fixed), { cwd: stackPath, ...opts });

export const up = lifecycle("up", "-d", "--remove-orphans");
export const down = lifecycle("down");
export const downRemoveOrphans = lifecycle("down", "--remove-orphans");
export const stop = lifecycle("stop");
export const restart = lifecycle("restart");
export const pull = lifecycle("pull");

export default {
	getStacksDir,
	getStackPath,
	findComposeFile,
	getComposeOptions,
	run,
	spawnCompose,
	composeLs,
	containerStates,
	composePs,
	composeConfig,
	ensureNetwork,
	getServiceContainerId,
	connectContainerToNetwork,
	inspectContainer,
	checkImageUpdate,
	discoverProjects,
	up,
	down,
	downRemoveOrphans,
	stop,
	restart,
	pull,
};
