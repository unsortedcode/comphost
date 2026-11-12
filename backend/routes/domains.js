import express from "express";
import internalDomains from "../internal/domains.js";
import jwtdecode from "../lib/express/jwt-decode.js";
import validator from "../lib/validator/index.js";
import { debug, express as logger } from "../logger.js";

const router = express.Router({ caseSensitive: true, strict: true, mergeParams: true });

/**
 * GET /api/domains — every domain and stream port served, flattened, with SSL
 * state and the stack behind it. Each host kind honours its own list permission.
 */
router
	.route("/")
	.options((_, res) => res.sendStatus(204))
	.all(jwtdecode())
	.get(async (req, res, next) => {
		try {
			res.status(200).send(await internalDomains.getAll(res.locals.access));
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * POST /api/domains/link — link a proxy or stream host to a stack service, or
 * unlink it (stack_id 0/absent). Target and nginx config are not touched.
 */
router
	.route("/link")
	.options((_, res) => res.sendStatus(204))
	.all(jwtdecode())
	.post(async (req, res, next) => {
		try {
			const data = await validator(
				{
					additionalProperties: false,
					required: ["kind", "host_id"],
					properties: {
						kind: { type: "string", enum: ["proxy", "stream"] },
						host_id: { type: "integer", minimum: 1 },
						stack_id: { type: "integer", minimum: 0 },
						service: { type: "string", minLength: 1 },
					},
				},
				req.body,
			);
			res.status(200).send(await internalDomains.link(res.locals.access, data));
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

export default router;
