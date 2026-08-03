import { spawn } from "node:child_process";
import fs from "node:fs";
import errs from "../lib/error.js";
import { global as logger } from "../logger.js";
import registryCredentialModel from "../models/registry_credential.js";
import internalAuditLog from "./audit-log.js";

const DOCKER_CONFIG = process.env.DOCKER_CONFIG || "/data/.docker";

const mask = (row) => (row ? { ...row, secret: row.secret ? "••••••••" : "" } : row);

/**
 * Run a docker command, feeding `input` on stdin. Resolves on exit 0.
 * @param {string[]} args @param {string} [input]
 */
const dockerWithStdin = (args, input) =>
	new Promise((resolve, reject) => {
		const child = spawn("docker", args, {
			env: { ...process.env, UV_USE_IO_URING: "0", DOCKER_CONFIG },
		});
		let stderr = "";
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `docker exited ${code}`))));
		if (input !== undefined) {
			child.stdin.write(input);
		}
		child.stdin.end();
	});

const ensureConfigDir = () => {
	fs.mkdirSync(DOCKER_CONFIG, { recursive: true });
};

/** For docker hub, `docker login` with no server targets the hub. */
const loginArgs = (registry) => {
	const r = (registry || "").trim();
	return r && r !== "docker.io" && r !== "https://index.docker.io/v1/" ? [r] : [];
};

const internalRegistry = {
	/**
	 * `docker login` a registry into the shared DOCKER_CONFIG (validates creds).
	 * @param {string} registry @param {string} username @param {string} secret
	 */
	login: async (registry, username, secret) => {
		ensureConfigDir();
		await dockerWithStdin(["login", ...loginArgs(registry), "-u", username, "--password-stdin"], secret);
	},

	/** `docker logout` a registry from the shared DOCKER_CONFIG (best-effort). */
	logout: async (registry) => {
		await dockerWithStdin(["logout", ...loginArgs(registry)]).catch(() => null);
	},

	create: async (access, data) => {
		await access.can("settings:update");
		// Validate by actually logging in first.
		await internalRegistry.login(data.registry, data.username, data.secret);
		const row = await registryCredentialModel.query().insertAndFetch({
			name: data.name,
			registry: data.registry,
			username: data.username,
			secret: data.secret,
			owner_user_id: access.token.getUserId(1),
			meta: {},
		});
		await internalAuditLog.add(access, {
			action: "created",
			object_type: "registry-credential",
			object_id: row.id,
			meta: { name: row.name, registry: row.registry, username: row.username },
		});
		return mask(row);
	},

	getAll: async (access) => {
		await access.can("settings:list");
		const rows = await registryCredentialModel.query().where("is_deleted", 0).orderBy("registry");
		return rows.map(mask);
	},

	delete: async (access, id) => {
		await access.can("settings:update");
		const row = await registryCredentialModel.query().where("is_deleted", 0).andWhere("id", id).first();
		if (!row) throw new errs.ItemNotFoundError(id);
		await internalRegistry.logout(row.registry);
		await registryCredentialModel.query().where("id", id).patch({ is_deleted: 1 });
		await internalAuditLog.add(access, {
			action: "deleted",
			object_type: "registry-credential",
			object_id: id,
			meta: { registry: row.registry },
		});
		return true;
	},

	/**
	 * Re-apply all stored logins to DOCKER_CONFIG (on boot, in case the config
	 * was lost). Best-effort — a failed login (e.g. expired token) is logged.
	 */
	initSync: async () => {
		try {
			const rows = await registryCredentialModel.query().where("is_deleted", 0);
			if (!rows.length) return;
			ensureConfigDir();
			for (const row of rows) {
				await internalRegistry
					.login(row.registry, row.username, row.secret)
					.then(() => logger.info(`Registry login synced: ${row.registry} (${row.username})`))
					.catch((err) => logger.error(`Registry login failed for ${row.registry}: ${err.message}`));
			}
		} catch (err) {
			logger.error(`Registry sync error: ${err.message}`);
		}
	},
};

export default internalRegistry;
