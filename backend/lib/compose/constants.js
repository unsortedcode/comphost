// Compose stack constants + pure helpers.
// Ported from Dockge (louislam/dockge) common/util-common.ts — MIT licensed — and
// converted to plain ESM to match this backend's conventions. No framework coupling.

// Stack status codes (kept numerically identical to Dockge for familiarity).
export const UNKNOWN = 0;
export const CREATED_FILE = 1; // draft: compose file on disk, not deployed
export const CREATED_STACK = 2; // created in docker compose but not running
export const RUNNING = 3;
export const EXITED = 4;
// Our own addition (Dockge stops at 4): some services up, some not. Very common
// with one-shot init/migration containers that exit 0 by design.
export const PARTIAL = 5;

export const statusName = (status) => {
	switch (status) {
		case CREATED_FILE:
			return "draft";
		case CREATED_STACK:
			return "created_stack";
		case RUNNING:
			return "running";
		case EXITED:
			return "exited";
		case PARTIAL:
			return "partial";
		default:
			return "unknown";
	}
};

// Compose files we recognise inside a stack directory, in priority order.
export const acceptedComposeFileNames = ["compose.yaml", "docker-compose.yaml", "docker-compose.yml", "compose.yml"];

// Stack directory names must be safe for the filesystem and compose project naming.
export const composeStackNameRegex = /^[a-z0-9_-]+$/;

/**
 * Status code from a list of individual container states ("running", "exited",
 * "created", "paused", "dead", "restarting"). Used when a stack ignores some of
 * its services — the aggregate string from `compose ls` can't be filtered, so the
 * states are counted here instead.
 *
 * @param   {string[]} states
 * @returns {number}
 */
export const statusFromStates = (states) => {
	if (!states?.length) {
		return UNKNOWN;
	}
	const counts = {};
	for (const state of states) {
		const key = String(state || "").toLowerCase();
		counts[key] = (counts[key] || 0) + 1;
	}
	return statusFromCounts(counts);
};

/**
 * Shared decision table for both status sources.
 * @param   {Object<string, number>} counts  state -> number of containers
 * @returns {number}
 */
const statusFromCounts = (counts) => {
	const running = counts.running || 0;
	// Everything that isn't up: exited, dead, paused, restarting, created, removing.
	const notRunning = Object.entries(counts).reduce((sum, [state, n]) => (state === "running" ? sum : sum + n), 0);

	if (running > 0) {
		return notRunning > 0 ? PARTIAL : RUNNING;
	}
	if (counts.created && notRunning === counts.created) {
		return CREATED_STACK;
	}
	return notRunning > 0 ? EXITED : UNKNOWN;
};

/**
 * Convert the aggregated status string from `docker compose ls` to a status code.
 * Input example: "exited(1), running(1)" or "created(2)".
 *
 * The string aggregates per-container states, so it has to be parsed by count
 * rather than by substring: compose sorts the states alphabetically, which puts
 * "exited" first, and a plain `includes("exited")` therefore reports a healthy
 * stack with one finished init container as fully Exited.
 *
 * @param   {string} status
 * @returns {number}
 */
export const statusConvert = (status) => {
	if (!status) {
		return UNKNOWN;
	}

	// "exited(1), running(2)" -> { exited: 1, running: 2 }
	const counts = {};
	for (const [, state, n] of status.matchAll(/([a-z]+)\((\d+)\)/g)) {
		counts[state] = (counts[state] || 0) + Number(n);
	}

	// No counts means an unexpected shape; fall back to substring matching, but
	// check running first so a mixed string isn't reported as fully exited.
	if (Object.keys(counts).length === 0) {
		if (status.startsWith("created")) {
			return CREATED_STACK;
		}
		if (status.includes("running")) {
			return RUNNING;
		}
		if (status.includes("exited")) {
			return EXITED;
		}
		return UNKNOWN;
	}

	return statusFromCounts(counts);
};

/**
 * Parse a compose/docker port spec into a browsable URL + display string.
 * Handles: "8000:8000", "127.0.0.1:8001:8001", ranges ("8000-8005:8000-8005"),
 * "/udp" protocol suffixes, and "->"-style output from `docker ps`.
 * Ported verbatim (logic) from Dockge common/util-common.ts:parseDockerPort.
 *
 * @param   {string} input
 * @param   {string} hostname
 * @returns {{url: string, display: string}}
 */
export const parseDockerPort = (input, hostname) => {
	let port;
	let display;

	const parts = input.split("/");
	let part1 = parts[0];
	let protocol = parts[1] || "tcp";

	// coming from docker ps, split host part
	const arrow = part1.indexOf("->");
	if (arrow >= 0) {
		part1 = part1.split("->")[0];
		const colon = part1.indexOf(":");
		if (colon >= 0) {
			part1 = part1.split(":")[1];
		}
	}

	const lastColon = part1.lastIndexOf(":");

	if (lastColon === -1) {
		// No colon: just a port or port range.
		const dash = part1.indexOf("-");
		port = dash === -1 ? part1 : part1.substring(0, dash);
		display = part1;
	} else {
		// Port mapping.
		let hostPart = part1.substring(0, lastColon);
		display = hostPart;

		const dash = part1.indexOf("-");
		if (dash !== -1) {
			hostPart = part1.substring(0, dash);
		}

		const colon = hostPart.indexOf(":");
		if (colon !== -1) {
			// ip:port
			hostname = hostPart.substring(0, colon);
			port = hostPart.substring(colon + 1);
		} else {
			port = hostPart;
		}
	}

	const portInt = parseInt(port, 10);

	if (portInt === 443) {
		protocol = "https";
	} else if (protocol === "tcp") {
		protocol = "http";
	}

	return {
		url: `${protocol}://${hostname}:${portInt}`,
		display: display,
	};
};

export default {
	UNKNOWN,
	CREATED_FILE,
	CREATED_STACK,
	RUNNING,
	EXITED,
	PARTIAL,
	statusName,
	statusConvert,
	statusFromStates,
	acceptedComposeFileNames,
	composeStackNameRegex,
	parseDockerPort,
};
