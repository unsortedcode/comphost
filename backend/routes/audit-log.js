import express from "express";
import internalAuditLog from "../internal/audit-log.js";
import jwtdecode from "../lib/express/jwt-decode.js";
import validator from "../lib/validator/index.js";
import { debug, express as logger } from "../logger.js";

const router = express.Router({
	caseSensitive: true,
	strict: true,
	mergeParams: true,
});

/**
 * /api/audit-log
 */
router
	.route("/")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())

	/**
	 * GET /api/audit-log
	 *
	 * Retrieve all logs
	 */
	.get(async (req, res, next) => {
		try {
			const data = await validator(
				{
					additionalProperties: false,
					properties: {
						expand: {
							$ref: "common#/properties/expand",
						},
						query: {
							$ref: "common#/properties/query",
						},
						object_type: { type: ["string", "null"], maxLength: 50 },
						action: { type: ["string", "null"], maxLength: 50 },
						stack: { type: ["string", "null"], maxLength: 255 },
						domain: { type: ["string", "null"], maxLength: 255 },
					},
				},
				{
					expand: typeof req.query.expand === "string" ? req.query.expand.split(",") : null,
					query: typeof req.query.query === "string" ? req.query.query : null,
					object_type: typeof req.query.object_type === "string" ? req.query.object_type : null,
					action: typeof req.query.action === "string" ? req.query.action : null,
					stack: typeof req.query.stack === "string" ? req.query.stack : null,
					domain: typeof req.query.domain === "string" ? req.query.domain : null,
				},
			);
			const rows = await internalAuditLog.getAll(res.locals.access, data.expand, data.query, {
				object_type: data.object_type,
				action: data.action,
				stack: data.stack,
				domain: data.domain,
			});
			res.status(200).send(rows);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * GET /api/audit-log/filters
 *
 * Distinct values present in the log, to populate the filter controls.
 * Declared before /:event_id so it isn't swallowed by that pattern.
 */
router
	.route("/filters")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.get(async (req, res, next) => {
		try {
			res.status(200).send(await internalAuditLog.filterOptions(res.locals.access));
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * Specific audit log entry
 *
 * /api/audit-log/123
 */
router
	.route("/:event_id")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())

	/**
	 * GET /api/audit-log/123
	 *
	 * Retrieve a specific entry
	 */
	.get(async (req, res, next) => {
		try {
			const data = await validator(
				{
					required: ["event_id"],
					additionalProperties: false,
					properties: {
						event_id: {
							$ref: "common#/properties/id",
						},
						expand: {
							$ref: "common#/properties/expand",
						},
					},
				},
				{
					event_id: req.params.event_id,
					expand:
						typeof req.query.expand === "string"
							? req.query.expand.split(",")
							: null,
				},
			);

			const item = await internalAuditLog.get(res.locals.access, {
				id: data.event_id,
				expand: data.expand,
			});
			res.status(200).send(item);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

export default router;
