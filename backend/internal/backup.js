import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZipArchive } from "archiver";
import { Cron } from "croner";
import errs from "../lib/error.js";
import { global as logger } from "../logger.js";
import orchestrator from "../lib/compose/orchestrator.js";
import backupTargetModel from "../models/backup_target.js";
import mountBackupModel from "../models/mount_backup.js";
import stackModel from "../models/stack.js";
import now from "../models/now_helper.js";
import internalAuditLog from "./audit-log.js";

// Secret keys masked in API responses.
const SECRET_KEYS = ["secret_access_key", "private_key", "password"];

const maskConfig = (config = {}) => {
	const out = { ...config };
	for (const k of SECRET_KEYS) {
		if (out[k]) out[k] = "••••••••";
	}
	return out;
};
const maskTarget = (row) => (row ? { ...row, config: maskConfig(row.config) } : row);

/**
 * Spawn a command, capturing stderr; resolve on exit 0, reject otherwise.
 * @param {string} cmd @param {string[]} args @param {Object} [opts]
 */
const runCmd = (cmd, args, opts = {}) =>
	new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { env: { ...process.env, UV_USE_IO_URING: "0" }, ...opts });
		let stderr = "";
		child.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr}`))));
	});

/**
 * Config backup: a zip of everything needed to restore CompHost's configuration
 * (NOT stack volume data — that's the separate volume-backup feature).
 * Contents: sqlite DB, JWT keys, generated nginx configs, and each stack's
 * compose file + .env.
 */
const internalBackup = {
	/**
	 * Build a config-backup zip and pipe it to a writable stream (e.g. the HTTP
	 * response). Resolves when finalized.
	 * @param   {import("stream").Writable} stream
	 * @returns {Promise<void>}
	 */
	configBackupStream: (stream) => {
		return new Promise((resolve, reject) => {
			const archive = new ZipArchive({ zlib: { level: 9 } });
			archive.on("error", reject);
			archive.on("end", resolve);
			archive.pipe(stream);

			// Core config files.
			for (const f of ["/data/database.sqlite", "/data/keys.json"]) {
				if (fs.existsSync(f)) {
					archive.file(f, { name: `data/${path.basename(f)}` });
				}
			}
			// Generated nginx configs.
			if (fs.existsSync("/data/nginx")) {
				archive.directory("/data/nginx", "data/nginx");
			}
			// Per-stack compose file + .env (config only, no volume data).
			const stacksDir = orchestrator.getStacksDir();
			if (fs.existsSync(stacksDir)) {
				for (const entry of fs.readdirSync(stacksDir, { withFileTypes: true })) {
					if (!entry.isDirectory()) continue;
					const dir = path.join(stacksDir, entry.name);
					const composeFile = orchestrator.findComposeFile(dir);
					if (composeFile) {
						archive.file(composeFile, { name: `stacks/${entry.name}/${path.basename(composeFile)}` });
					}
					const envFile = path.join(dir, ".env");
					if (fs.existsSync(envFile)) {
						archive.file(envFile, { name: `stacks/${entry.name}/.env` });
					}
				}
			}

			archive.finalize();
		});
	},

	// --- Backup targets (destinations) --------------------------------------

	/**
	 * Generate an ed25519 keypair for an SSH target. The public half is shown in
	 * the UI so it can be pasted into the remote host's authorized_keys — no need
	 * to hand CompHost an existing private key.
	 * @returns {Promise<{privateKey: string, publicKey: string}>}
	 */
	generateSshKey: async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comphost-key-"));
		const keyPath = path.join(dir, "id_ed25519");
		try {
			await runCmd("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "comphost-backup", "-f", keyPath]);
			return {
				privateKey: fs.readFileSync(keyPath, "utf8"),
				publicKey: fs.readFileSync(`${keyPath}.pub`, "utf8").trim(),
			};
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},

	/**
	 * Verify a target actually works: SSH → connect and touch the remote dir;
	 * S3 → list the bucket. Returns a human-readable result.
	 * @param   {number} id
	 * @returns {Promise<{ok: boolean, message: string}>}
	 */
	testTarget: async (access, id) => {
		await access.can("settings:list");
		const target = await internalBackup.getTargetRaw(id);
		if (!target) throw new errs.ItemNotFoundError(id);
		const c = target.config || {};
		try {
			if (target.type === "ssh") {
				const keyFile = path.join(os.tmpdir(), `comphost-test-${Date.now()}`);
				fs.writeFileSync(keyFile, c.private_key?.endsWith("\n") ? c.private_key : `${c.private_key}\n`, {
					mode: 0o600,
				});
				try {
					await runCmd("ssh", [
						"-i", keyFile, "-p", `${c.port || 22}`, "-o", "BatchMode=yes",
						"-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=/dev/null",
						"-o", "ConnectTimeout=10", `${c.user}@${c.host}`, `mkdir -p '${c.path || "."}' && echo ok`,
					]);
				} finally {
					fs.rmSync(keyFile, { force: true });
				}
				return { ok: true, message: `Connected to ${c.user}@${c.host} and ${c.path} is writable.` };
			}
			await runCmd("rclone", [
				"lsd", `:s3:${c.bucket}`,
				"--s3-provider", c.provider || "Other",
				"--s3-access-key-id", c.access_key_id || "",
				"--s3-secret-access-key", c.secret_access_key || "",
				"--s3-endpoint", c.endpoint || "",
				"--s3-region", c.region || "us-east-1",
				`--s3-force-path-style=${c.force_path_style === false ? "false" : "true"}`,
			]);
			return { ok: true, message: `Bucket "${c.bucket}" is reachable.` };
		} catch (err) {
			return { ok: false, message: err.message };
		}
	},

	createTarget: async (access, data) => {
		await access.can("settings:update");
		const config = { ...(data.config || {}) };
		// SSH target with no key supplied → generate one and surface the public half
		// so the user can install it on the remote host.
		if (data.type === "ssh" && !config.private_key) {
			const { privateKey, publicKey } = await internalBackup.generateSshKey();
			config.private_key = privateKey;
			config.public_key = publicKey;
		}
		const row = await backupTargetModel.query().insertAndFetch({
			name: data.name,
			type: data.type,
			config,
			schedule_cron: data.schedule_cron || "",
			enabled: data.enabled !== false,
			schedule_hours: Number.parseInt(data.schedule_hours, 10) || 0,
			owner_user_id: access.token.getUserId(1),
			meta: {},
		});
		await internalAuditLog.add(access, { action: "created", object_type: "backup-target", object_id: row.id, meta: { name: row.name, type: row.type } });
		return maskTarget(row);
	},

	getAllTargets: async (access) => {
		await access.can("settings:list");
		const rows = await backupTargetModel.query().where("is_deleted", 0).orderBy("name");
		return rows.map(maskTarget);
	},

	updateTarget: async (access, id, data) => {
		await access.can("settings:update");
		const existing = await backupTargetModel.query().where("is_deleted", 0).andWhere("id", id).first();
		if (!existing) throw new errs.ItemNotFoundError(id);
		const patch = {};
		for (const k of ["name", "type", "enabled"]) if (data[k] !== undefined) patch[k] = data[k];
		if (data.schedule_hours !== undefined) patch.schedule_hours = Number.parseInt(data.schedule_hours, 10) || 0;
		if (data.schedule_cron !== undefined) {
			const expr = String(data.schedule_cron).trim();
			if (expr) {
				// Fail fast on a bad expression rather than silently never running.
				try {
					new Cron(expr);
				} catch (err) {
					throw new errs.ValidationError(`Invalid cron expression: ${err.message}`);
				}
			}
			patch.schedule_cron = expr;
		}
		if (data.config !== undefined) {
			// Preserve existing secrets when the client sends the masked placeholder.
			const merged = { ...existing.config, ...data.config };
			for (const s of SECRET_KEYS) {
				if (data.config[s] === "••••••••" || data.config[s] === undefined) merged[s] = existing.config[s];
			}
			patch.config = merged;
		}
		await backupTargetModel.query().where("id", id).patch(patch);
		return maskTarget(await backupTargetModel.query().findById(id));
	},

	deleteTarget: async (access, id) => {
		await access.can("settings:update");
		const row = await backupTargetModel.query().where("is_deleted", 0).andWhere("id", id).first();
		await backupTargetModel.query().where("id", id).patch({ is_deleted: 1 });
		await internalAuditLog.add(access, {
			action: "deleted",
			object_type: "backup-target",
			object_id: id,
			meta: { name: row?.name, type: row?.type },
		});
		return true;
	},

	// --- Volume backup ------------------------------------------------------

	/**
	 * List the named docker volumes used by a stack's running containers.
	 * @param   {string} stackPath
	 * @returns {Promise<Array<{name: string, destination: string}>>}
	 */
	listStackVolumes: async (stackPath, projectName) => {
		const all = await internalBackup.listStackMounts(stackPath, projectName);
		return all.filter((m) => m.kind === "volume");
	},

	/**
	 * Every persistent thing a stack owns: named docker volumes AND bind mounts
	 * (host filesystem paths). They want different treatment — volumes are
	 * snapshotted with tar, bind mounts are usually better served by rsync.
	 * @param   {string} stackPath
	 * @param   {string} [projectName]
	 * @returns {Promise<Array<{kind: string, source: string, destination: string|null, readable: boolean}>>}
	 */
	listStackMounts: async (stackPath, projectName) => {
		const stacksDir = orchestrator.getStacksDir();
		const volumes = new Map();

		// 1. Mounts of the stack's containers. This also gives us the mount
		//    destination, which is useful context — but it only sees containers
		//    that currently exist.
		const { stdout } = await orchestrator.run(orchestrator.getComposeOptions(stackPath, stacksDir, "ps", "-q"), {
			cwd: stackPath,
		});
		const ids = stdout.trim().split(/\r?\n/).filter(Boolean);
		for (const id of ids) {
			const insp = await orchestrator.run(["inspect", id, "--format", "json"]);
			try {
				const arr = JSON.parse(insp.stdout);
				for (const c of arr) {
					for (const m of c.Mounts || []) {
						if (m.Type === "volume" && m.Name) {
							volumes.set(`volume:${m.Name}`, {
								kind: "volume",
								source: m.Name,
								destination: m.Destination,
							});
						} else if (m.Type === "bind" && m.Source) {
							volumes.set(`bind:${m.Source}`, {
								kind: "bind",
								source: m.Source,
								destination: m.Destination,
							});
						}
					}
				}
			} catch {
				// skip
			}
		}

		// 2. Every named volume compose created for this project, via its label.
		//    Catches stacks that are stopped/down (no containers to inspect) and
		//    volumes no running service currently mounts — without this, backing up
		//    a stopped stack silently copies nothing.
		if (projectName) {
			const res = await orchestrator
				.run(["volume", "ls", "--filter", `label=com.docker.compose.project=${projectName}`, "--format", "{{.Name}}"])
				.catch(() => null);
			for (const name of (res?.stdout || "").trim().split(/\r?\n/).filter(Boolean)) {
				if (!volumes.has(`volume:${name}`)) {
					volumes.set(`volume:${name}`, { kind: "volume", source: name, destination: null });
				}
			}
		}

		// Flag whether a bind source is visible from inside CompHost. If it is we can
		// rsync it directly (incremental); if not we must snapshot it through a
		// helper container instead (see backupOne).
		return [...volumes.values()].map((m) => ({
			...m,
			readable: m.kind === "bind" ? fs.existsSync(m.source) : true,
		}));
	},

	/**
	 * Tar a named volume to a local file by streaming from a throwaway container
	 * (avoids bind-mount path-identity issues — data comes over stdout).
	 * @param {string} volumeName @param {string} outFile
	 */
	tarVolume: (volumeName, outFile) =>
		new Promise((resolve, reject) => {
			const out = fs.createWriteStream(outFile);
			const child = spawn(
				"docker",
				["run", "--rm", "-v", `${volumeName}:/v:ro`, "alpine", "tar", "czf", "-", "-C", "/v", "."],
				{ env: { ...process.env, UV_USE_IO_URING: "0" } },
			);
			let stderr = "";
			child.stderr.on("data", (d) => {
				stderr += d.toString();
			});
			child.stdout.pipe(out);
			child.on("error", reject);
			out.on("error", reject);
			child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar failed: ${stderr}`))));
		}),

	/** Push a local file to a target. */
	pushToTarget: async (target, localFile, remoteName) => {
		const c = target.config || {};
		if (target.type === "s3") {
			const remote = `:s3:${c.bucket}/${(c.path_prefix || "").replace(/^\/+|\/+$/g, "")}/${remoteName}`.replace(
				/\/{2,}/g,
				"/",
			);
			await runCmd("rclone", [
				"copyto", localFile, remote,
				"--s3-provider", c.provider || "Other",
				"--s3-access-key-id", c.access_key_id || "",
				"--s3-secret-access-key", c.secret_access_key || "",
				"--s3-endpoint", c.endpoint || "",
				"--s3-region", c.region || "us-east-1",
				`--s3-force-path-style=${c.force_path_style === false ? "false" : "true"}`,
			]);
		} else if (target.type === "ssh") {
			if (!c.private_key) throw new errs.ValidationError("SSH backup target requires a private_key");
			const keyFile = path.join(os.tmpdir(), `comphost-key-${Date.now()}`);
			fs.writeFileSync(keyFile, c.private_key.endsWith("\n") ? c.private_key : `${c.private_key}\n`, { mode: 0o600 });
			try {
				const remoteDir = `${(c.path || ".").replace(/\/+$/, "")}/${path.dirname(remoteName)}`;
				const ssh = `ssh -i ${keyFile} -p ${c.port || 22} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null`;
				// Ensure the remote dir exists, then rsync the file.
				await runCmd("ssh", [
					"-i", keyFile, "-p", `${c.port || 22}`, "-o", "StrictHostKeyChecking=accept-new",
					"-o", "UserKnownHostsFile=/dev/null", `${c.user}@${c.host}`, `mkdir -p '${remoteDir}'`,
				]);
				await runCmd("rsync", ["-az", "-e", ssh, localFile, `${c.user}@${c.host}:${remoteDir}/${path.basename(remoteName)}`]);
			} finally {
				fs.rmSync(keyFile, { force: true });
			}
		} else {
			throw new errs.ValidationError(`Unknown backup target type: ${target.type}`);
		}
	},

	/**
	 * rsync a directory tree to a target. Incremental — only changed files move,
	 * which is why it's the better default for bind mounts.
	 * @param {Object} target @param {string} localDir @param {string} remoteSubPath
	 */
	rsyncToTarget: async (target, localDir, remoteSubPath) => {
		const c = target.config || {};
		if (target.type === "ssh") {
			if (!c.private_key) throw new errs.ValidationError("SSH backup target has no private key");
			const keyFile = path.join(os.tmpdir(), `comphost-key-${Date.now()}`);
			fs.writeFileSync(keyFile, c.private_key.endsWith("\n") ? c.private_key : `${c.private_key}\n`, { mode: 0o600 });
			try {
				const remoteDir = `${(c.path || ".").replace(/\/+$/, "")}/${remoteSubPath}`;
				const sshCmd = `ssh -i ${keyFile} -p ${c.port || 22} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null`;
				await runCmd("ssh", [
					"-i", keyFile, "-p", `${c.port || 22}`, "-o", "StrictHostKeyChecking=accept-new",
					"-o", "UserKnownHostsFile=/dev/null", `${c.user}@${c.host}`, `mkdir -p '${remoteDir}'`,
				]);
				// Trailing slash: copy the CONTENTS of localDir into remoteDir.
				await runCmd("rsync", ["-az", "--delete", "-e", sshCmd, `${localDir}/`, `${c.user}@${c.host}:${remoteDir}/`]);
			} finally {
				fs.rmSync(keyFile, { force: true });
			}
		} else if (target.type === "s3") {
			const remote = `:s3:${c.bucket}/${(c.path_prefix || "").replace(/^\/+|\/+$/g, "")}/${remoteSubPath}`.replace(
				/\/{2,}/g,
				"/",
			);
			await runCmd("rclone", [
				"sync", localDir, remote,
				"--s3-provider", c.provider || "Other",
				"--s3-access-key-id", c.access_key_id || "",
				"--s3-secret-access-key", c.secret_access_key || "",
				"--s3-endpoint", c.endpoint || "",
				"--s3-region", c.region || "us-east-1",
				`--s3-force-path-style=${c.force_path_style === false ? "false" : "true"}`,
			]);
		} else {
			throw new errs.ValidationError(`Unknown backup target type: ${target.type}`);
		}
	},

	/**
	 * Back up one mount (volume or bind) to a target using the given method.
	 * @returns {Promise<number>} bytes transferred (0 for rsync — it's incremental)
	 */
	backupOne: async (stackName, mount, target, method, stamp, tmpDir) => {
		// rsync only works on a directory we can actually read. A bind path that
		// isn't visible inside CompHost has to be snapshotted via a helper container.
		const canRsync = method === "rsync" && mount.kind === "bind" && mount.readable;
		if (canRsync) {
			await internalBackup.rsyncToTarget(target, mount.source, `${stackName}/binds${mount.source}`);
			return 0;
		}
		if (method === "rsync" && mount.kind === "bind" && !mount.readable) {
			logger.info(
				`Bind ${mount.source} is not visible inside CompHost — snapshotting with tar instead of rsync.`,
			);
		}
		const safe = `${mount.kind}-${mount.source}`.replace(/[^a-zA-Z0-9._-]/g, "_");
		const local = path.join(tmpDir, `${safe}.tar.gz`);
		if (mount.kind === "volume") {
			await internalBackup.tarVolume(mount.source, local);
		} else {
			await internalBackup.tarHostPath(mount.source, local);
		}
		const bytes = fs.statSync(local).size;
		await internalBackup.pushToTarget(target, local, `${stackName}/${safe}-${stamp}.tar.gz`);
		fs.rmSync(local, { force: true });
		return bytes;
	},

	/**
	 * Tar a host path via a throwaway container — works for bind sources CompHost
	 * cannot see itself (the daemon resolves the path on the host).
	 */
	tarHostPath: (hostPath, outFile) =>
		new Promise((resolve, reject) => {
			const out = fs.createWriteStream(outFile);
			const child = spawn(
				"docker",
				["run", "--rm", "-v", `${hostPath}:/src:ro`, "alpine", "tar", "czf", "-", "-C", "/src", "."],
				{ env: { ...process.env, UV_USE_IO_URING: "0" } },
			);
			let stderr = "";
			child.stderr.on("data", (d) => {
				stderr += d.toString();
			});
			child.stdout.pipe(out);
			child.on("error", reject);
			out.on("error", reject);
			child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar failed: ${stderr}`))));
		}),

	/**
	 * Back up a stack's data. Each volume/bind can specify its own target and
	 * method (mount_backup rows); anything unconfigured falls back to
	 * `defaultTarget` with tar for volumes and rsync for bind mounts.
	 * @param   {Object} stackRow      { id, name }
	 * @param   {Object} defaultTarget
	 * @returns {Promise<{volumes: string[], skipped: string[], bytes: number}>}
	 */
	backupStackVolumes: async (stackRow, defaultTarget) => {
		const stackPath = orchestrator.getStackPath(stackRow.name);
		// Pass the compose project name so volumes are found even when the stack is
		// stopped (label lookup), not just from running containers.
		const mounts = await internalBackup.listStackMounts(stackPath, stackRow.name);
		const rows = await mountBackupModel.query().where("stack_id", stackRow.id);
		const bySource = Object.fromEntries(rows.map((r) => [r.source, r]));

		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comphost-bk-"));
		const done = [];
		const skipped = [];
		let bytes = 0;
		try {
			for (const mount of mounts) {
				const cfg = bySource[mount.source];
				if (cfg && cfg.enabled === false) {
					skipped.push(mount.source);
					continue;
				}
				const targetId = cfg?.target_id || defaultTarget?.id || 0;
				const target = targetId === defaultTarget?.id ? defaultTarget : await internalBackup.getTargetRaw(targetId);
				if (!target) {
					skipped.push(mount.source);
					continue;
				}
				// Default policy: rsync bind mounts (incremental), tar volumes.
				const method = cfg?.method || (mount.kind === "bind" ? "rsync" : "tar");
				bytes += await internalBackup.backupOne(stackRow.name, mount, target, method, stamp, tmpDir);
				done.push(mount.source);
			}
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
		logger.info(
			`Backed up stack ${stackRow.name}: ${done.length} mount(s), ${skipped.length} skipped, ${bytes} bytes`,
		);
		return { volumes: done, skipped, bytes };
	},

	// --- Per-mount configuration --------------------------------------------

	/** Discovered mounts for a stack, merged with their saved backup config. */
	getStackMounts: async (stackRow) => {
		const stackPath = orchestrator.getStackPath(stackRow.name);
		const mounts = await internalBackup.listStackMounts(stackPath, stackRow.name);
		const rows = await mountBackupModel.query().where("stack_id", stackRow.id);
		const bySource = Object.fromEntries(rows.map((r) => [r.source, r]));
		return mounts.map((m) => {
			const cfg = bySource[m.source];
			return {
				...m,
				targetId: cfg?.target_id ?? 0,
				method: cfg?.method || (m.kind === "bind" ? "rsync" : "tar"),
				enabled: cfg ? cfg.enabled !== false : true,
				// rsync needs a readable path; surfaced so the UI can explain itself.
				rsyncAvailable: m.kind === "bind" && m.readable,
			};
		});
	},

	/** Upsert the backup config for a stack's mounts. */
	setStackMounts: async (access, stackRow, items) => {
		await access.can("stacks:update", stackRow.id);
		for (const item of items) {
			const patch = {
				stack_id: stackRow.id,
				kind: item.kind,
				source: item.source,
				target_id: Number.parseInt(item.target_id, 10) || 0,
				method: item.method === "rsync" ? "rsync" : "tar",
				enabled: item.enabled !== false,
			};
			const existing = await mountBackupModel
				.query()
				.where("stack_id", stackRow.id)
				.andWhere("source", item.source)
				.first();
			if (existing) {
				await mountBackupModel.query().where("id", existing.id).patch(patch);
			} else {
				await mountBackupModel.query().insert({ ...patch, meta: {} });
			}
		}
		return internalBackup.getStackMounts(stackRow);
	},

	/** Fetch a target incl. secrets (internal use). */
	getTargetRaw: (id) => backupTargetModel.query().where("is_deleted", 0).andWhere("id", id).first(),

	// --- Scheduling ---------------------------------------------------------

	/**
	 * Is a target due? A cron expression wins when set ("has a scheduled run
	 * elapsed since we last ran?"); otherwise fall back to the every-N-hours field.
	 * @param   {Object} target
	 * @param   {number} nowMs
	 * @returns {boolean}
	 */
	isDue: (target, nowMs) => {
		const last = target.last_run ? new Date(target.last_run).getTime() : 0;
		if (target.schedule_cron) {
			try {
				const prev = new Cron(target.schedule_cron).previousRun();
				return !!prev && prev.getTime() > last;
			} catch (err) {
				logger.error(`Backup target "${target.name}" has an invalid cron (${target.schedule_cron}): ${err.message}`);
				return false;
			}
		}
		if (!target.schedule_hours) return false;
		return nowMs - last >= target.schedule_hours * 3600 * 1000;
	},

	/** Run any due scheduled targets: back up all stacks to each. */
	runScheduled: async () => {
		const all = await backupTargetModel.query().where("is_deleted", 0).andWhere("enabled", 1);
		const nowMs = Date.now();
		const targets = all.filter((t) => internalBackup.isDue(t, nowMs));
		if (!targets.length) return;
		const stacks = await stackModel.query().where("is_deleted", 0);
		for (const target of targets) {
			logger.info(`Scheduled backup to ${target.name} (${stacks.length} stacks)`);
			for (const stack of stacks) {
				try {
					await internalBackup.backupStackVolumes(stack, target);
				} catch (err) {
					logger.error(`Scheduled backup of ${stack.name} -> ${target.name} failed: ${err.message}`);
				}
			}
			await backupTargetModel.query().where("id", target.id).patch({ last_run: now() });
		}
	},

	/**
	 * Start the scheduled-backup timer. Ticks every minute so cron expressions
	 * fire close to their intended time (a coarser tick would round them off).
	 */
	initTimer: () => {
		setInterval(() => {
			internalBackup.runScheduled().catch((err) => logger.error(`Backup scheduler error: ${err.message}`));
		}, 60 * 1000);
		logger.info("Backup scheduler started (1m tick, cron-aware)");
	},
};

export default internalBackup;
