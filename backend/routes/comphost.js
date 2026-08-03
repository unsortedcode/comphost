// CompHost-specific settings API (admin-only): Cloudflare, backups, etc.
import express from "express";
import internalBackup from "../internal/backup.js";
import internalCloudflare from "../internal/cloudflare.js";
import internalRegistry from "../internal/registry.js";
import jwtdecode from "../lib/express/jwt-decode.js";
import validator from "../lib/validator/index.js";
import { debug, express as logger } from "../logger.js";

const router = express.Router({ caseSensitive: true, strict: true, mergeParams: true });

/**
 * /api/comphost/cloudflare — get (masked) / set Cloudflare config.
 */
router
	.route("/cloudflare/check")
	.options((_, res) => res.sendStatus(204))
	.all(jwtdecode())
	/**
	 * POST /api/comphost/cloudflare/check — what Cloudflare currently holds for
	 * these domains. Read-only; drives the pre-save warning in the host modals.
	 */
	.post(async (req, res, next) => {
		try {
			await req.res.locals.access.can("settings:list");
			const domains = Array.isArray(req.body?.domains) ? req.body.domains.slice(0, 25) : [];
			res.status(200).send(await internalCloudflare.checkDomains(domains));
		} catch (err) {
			debug(logger, `${req.method} ${req.path}: ${err}`);
			next(err);
		}
	});

router
	.route("/cloudflare")
	.options((_, res) => res.sendStatus(204))
	.all(jwtdecode())
	.get(async (req, res, next) => {
		try {
			await req.res.locals.access.can("settings:list");
			res.status(200).send(await internalCloudflare.getConfigMasked());
		} catch (err) {
			debug(logger, `${req.method} ${req.path}: ${err}`);
			next(err);
		}
	})
	.post(async (req, res, next) => {
		try {
			await res.locals.access.can("settings:update");
			const data = await validator(
				{
					additionalProperties: false,
					properties: {
						api_token: { type: "string" },
						email: { type: "string" },
						proxied: { type: "boolean" },
						public_ip: { type: "string" },
					},
				},
				req.body,
			);
			const result = await internalCloudflare.setConfig({
				apiToken: data.api_token,
				email: data.email,
				proxied: data.proxied,
				publicIp: data.public_ip,
			});
			res.status(200).send(result);
		} catch (err) {
			debug(logger, `${req.method} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * Private registry logins — /api/comphost/registries
 */
router
	.route("/registries")
	.options((_, res) => res.sendStatus(204))
	.all(jwtdecode())
	.get(async (req, res, next) => {
		try {
			res.status(200).send(await internalRegistry.getAll(res.locals.access));
		} catch (err) {
			debug(logger, `${req.method} ${req.path}: ${err}`);
			next(err);
		}
	})
	.post(async (req, res, next) => {
		try {
			const data = await validator(
				{
					additionalProperties: false,
					required: ["name", "registry", "username", "secret"],
					properties: {
						name: { type: "string", minLength: 1 },
						registry: { type: "string", minLength: 1 },
						username: { type: "string", minLength: 1 },
						secret: { type: "string", minLength: 1 },
					},
				},
				req.body,
			);
			res.status(201).send(await internalRegistry.create(res.locals.access, data));
		} catch (err) {
			debug(logger, `${req.method} ${req.path}: ${err}`);
			next(err);
		}
	});

router
	.route("/registries/:id")
	.options((_, res) => res.sendStatus(204))
	.all(jwtdecode())
	.delete(async (req, res, next) => {
		try {
			res.status(200).send(await internalRegistry.delete(res.locals.access, Number.parseInt(req.params.id, 10)));
		} catch (err) {
			debug(logger, `${req.method} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * Backup targets — /api/comphost/backup/targets
 */
router
	.route("/backup/targets")
	.options((_, res) => res.sendStatus(204))
	.all(jwtdecode())
	.get(async (req, res, next) => {
		try {
			res.status(200).send(await internalBackup.getAllTargets(res.locals.access));
		} catch (err) {
			debug(logger, `${req.method} ${req.path}: ${err}`);
			next(err);
		}
	})
	.post(async (req, res, next) => {
		try {
			const data = await validator(
				{
					additionalProperties: false,
					required: ["name", "type", "config"],
					properties: {
						name: { type: "string", minLength: 1 },
						type: { type: "string", enum: ["s3", "ssh"] },
						config: { type: "object" },
						enabled: { type: "boolean" },
						schedule_hours: { type: "integer", minimum: 0 },
					},
				},
				req.body,
			);
			res.status(201).send(await internalBackup.createTarget(res.locals.access, data));
		} catch (err) {
			debug(logger, `${req.method} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * POST /api/comphost/backup/targets/:id/test — verify the target really works
 * (SSH: connect + writable path; S3: bucket reachable).
 */
router
	.route("/backup/targets/:id/test")
	.options((_, res) => res.sendStatus(204))
	.all(jwtdecode())
	.post(async (req, res, next) => {
		try {
			res.status(200).send(await internalBackup.testTarget(res.locals.access, Number.parseInt(req.params.id, 10)));
		} catch (err) {
			debug(logger, `${req.method} ${req.path}: ${err}`);
			next(err);
		}
	});

router
	.route("/backup/targets/:id")
	.options((_, res) => res.sendStatus(204))
	.all(jwtdecode())
	.put(async (req, res, next) => {
		try {
			const id = Number.parseInt(req.params.id, 10);
			res.status(200).send(await internalBackup.updateTarget(res.locals.access, id, req.body));
		} catch (err) {
			debug(logger, `${req.method} ${req.path}: ${err}`);
			next(err);
		}
	})
	.delete(async (req, res, next) => {
		try {
			const id = Number.parseInt(req.params.id, 10);
			res.status(200).send(await internalBackup.deleteTarget(res.locals.access, id));
		} catch (err) {
			debug(logger, `${req.method} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * GET /api/comphost/backup/config — download a config backup zip.
 */
router
	.route("/backup/config")
	.options((_, res) => res.sendStatus(204))
	.all(jwtdecode())
	.get(async (req, res, next) => {
		try {
			await res.locals.access.can("settings:list");
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			res.setHeader("Content-Type", "application/zip");
			res.setHeader("Content-Disposition", `attachment; filename="comphost-config-${stamp}.zip"`);
			await internalBackup.configBackupStream(res);
		} catch (err) {
			debug(logger, `${req.method} ${req.path}: ${err}`);
			next(err);
		}
	});

export default router;

