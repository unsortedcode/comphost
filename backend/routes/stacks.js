// Import the built file directly: composerize's package `main` field isn't
// resolvable under strict Node ESM (works in Dockge only because it runs via tsx).
// Pinned to 1.7.1, so this dist path is stable.
import composerize from "composerize/dist/composerize.js";
import express from "express";
import internalBackup from "../internal/backup.js";
import internalStack from "../internal/stack.js";
import { issueTicket } from "../lib/ws/ticket.js";
import errs from "../lib/error.js";
import jwtdecode from "../lib/express/jwt-decode.js";
import validator from "../lib/validator/index.js";
import { debug, express as logger } from "../logger.js";

const router = express.Router({
	caseSensitive: true,
	strict: true,
	mergeParams: true,
});

const parseId = (raw) => {
	const id = Number.parseInt(raw, 10);
	return Number.isNaN(id) ? null : id;
};

// Shared payload schema for expose (blocking + streaming variants).
// Body arrives snake_case (frontend base.ts decamelizes keys).
const exposeSchema = {
	additionalProperties: false,
	required: ["service", "port", "domain_names"],
	properties: {
		service: { type: "string", minLength: 1 },
		port: { type: "integer", minimum: 1, maximum: 65535 },
		domain_names: { type: "array", items: { type: "string" }, minItems: 1 },
		forward_scheme: { type: "string", enum: ["http", "https"] },
		ssl_forced: { type: "boolean" },
		// "new" = request Let's Encrypt; number = existing cert; else none.
		certificate: {},
		certificate_id: {},
		cloudflare: { type: "boolean" },
		access_list_id: {},
		// Optional explicit network alias; otherwise a compose-declared alias for
		// the comphost network is used, else <stack>-<service>.
		alias: { type: "string" },
		basic_auth: {
			type: "object",
			additionalProperties: false,
			properties: {
				username: { type: "string" },
				password: { type: "string" },
			},
		},
	},
};

/**
 * /api/stacks
 */
router
	.route("/")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())

	/**
	 * GET /api/stacks
	 */
	.get(async (req, res, next) => {
		try {
			const data = await validator(
				{
					additionalProperties: false,
					properties: {
						expand: { $ref: "common#/properties/expand" },
						query: { $ref: "common#/properties/query" },
					},
				},
				{
					expand: typeof req.query.expand === "string" ? req.query.expand.split(",") : null,
					query: typeof req.query.query === "string" ? req.query.query : null,
				},
			);
			const rows = await internalStack.getAll(res.locals.access, data.expand, data.query);
			res.status(200).send(rows);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	})

	/**
	 * POST /api/stacks
	 */
	.post(async (req, res, next) => {
		try {
			const payload = await validator(
				{
					additionalProperties: false,
					required: ["name", "compose_content"],
					properties: {
						name: { type: "string", minLength: 1, pattern: "^[a-z0-9_-]+$" },
						compose_content: { type: "string", minLength: 1 },
						compose_file_name: { type: "string", minLength: 1 },
					},
				},
				req.body,
			);
			const result = await internalStack.create(res.locals.access, payload);
			res.status(201).send(result);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * POST /api/stacks/composerize — convert a `docker run ...` command to compose YAML.
 */
router
	.route("/composerize")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.post(async (req, res, next) => {
		try {
			// Any authenticated user with stacks view can convert; it's a pure helper.
			await res.locals.access.can("stacks:list");
			const data = await validator(
				{
					additionalProperties: false,
					required: ["command"],
					properties: { command: { type: "string", minLength: 1 } },
				},
				req.body,
			);
			const compose = composerize(data.command);
			res.status(200).send({ compose });
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});


/**
 * GET /api/stacks/discover — compose projects on this host not yet managed by
 * CompHost (for adopting an existing box).
 */
router
	.route("/discover")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.get(async (req, res, next) => {
		try {
			res.status(200).send(await internalStack.discover(res.locals.access));
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * GET /api/stacks/browse?path=/opt — list directories CompHost can see, marking
 * the ones that contain a compose file. Lets a stopped project (invisible to
 * `docker compose ls`) be found and adopted.
 */
router
	.route("/browse")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.get(async (req, res, next) => {
		try {
			res.status(200).send(await internalStack.browse(res.locals.access, req.query.path));
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * POST /api/stacks/adopt — register an existing compose project in place.
 */
router
	.route("/adopt")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.post(async (req, res, next) => {
		try {
			const payload = await validator(
				{
					additionalProperties: false,
					required: ["name"],
					properties: {
						name: { type: "string", minLength: 1, pattern: "^[a-z0-9_-]+$" },
						compose_dir: { type: "string" },
					},
				},
				req.body,
			);
			res.status(201).send(await internalStack.adopt(res.locals.access, payload));
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * Specific stack — /api/stacks/123
 */
router
	.route("/:stack_id")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())

	.get(async (req, res, next) => {
		try {
			const id = parseId(req.params.stack_id);
			const data = await validator(
				{
					additionalProperties: false,
					properties: { expand: { $ref: "common#/properties/expand" } },
				},
				{ expand: typeof req.query.expand === "string" ? req.query.expand.split(",") : null },
			);
			const row = await internalStack.get(res.locals.access, { id, expand: data.expand });
			res.status(200).send(row);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	})

	.put(async (req, res, next) => {
		try {
			const id = parseId(req.params.stack_id);
			const payload = await validator(
				{
					additionalProperties: false,
					properties: {
						compose_content: { type: "string" },
						compose_file_name: { type: "string", minLength: 1 },
					},
				},
				req.body,
			);
			payload.id = id;
			const result = await internalStack.update(res.locals.access, payload);
			res.status(200).send(result);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	})

	.delete(async (req, res, next) => {
		try {
			const id = parseId(req.params.stack_id);
			const result = await internalStack.delete(res.locals.access, { id });
			res.status(200).send(result);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});


/**
 * GET /api/stacks/123/updates — per-service image update check.
 */
router
	.route("/:stack_id/updates")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.get(async (req, res, next) => {
		try {
			res.status(200).send(await internalStack.checkUpdates(res.locals.access, parseId(req.params.stack_id)));
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * Per-mount backup config — GET/PUT /api/stacks/123/mounts
 */
router
	.route("/:stack_id/mounts")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.get(async (req, res, next) => {
		try {
			const row = await internalStack.get(res.locals.access, { id: parseId(req.params.stack_id) });
			res.status(200).send(await internalBackup.getStackMounts(row));
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	})
	.put(async (req, res, next) => {
		try {
			const payload = await validator(
				{
					additionalProperties: false,
					required: ["mounts"],
					properties: {
						mounts: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								required: ["kind", "source"],
								properties: {
									kind: { type: "string", enum: ["volume", "bind"] },
									source: { type: "string", minLength: 1 },
									target_id: { type: "integer", minimum: 0 },
									method: { type: "string", enum: ["tar", "rsync"] },
									enabled: { type: "boolean" },
								},
							},
						},
					},
				},
				req.body,
			);
			const row = await internalStack.get(res.locals.access, { id: parseId(req.params.stack_id) });
			res.status(200).send(await internalBackup.setStackMounts(res.locals.access, row, payload.mounts));
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * On-demand volume backup — POST /api/stacks/123/backup { target_id }
 */
router
	.route("/:stack_id/backup")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.post(async (req, res, next) => {
		try {
			const id = parseId(req.params.stack_id);
			const data = await validator(
				{ additionalProperties: false, required: ["target_id"], properties: { target_id: { type: "integer" } } },
				req.body,
			);
			const result = await internalStack.backup(res.locals.access, { id, target_id: data.target_id });
			res.status(200).send(result);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * Services list — GET /api/stacks/123/services
 */
router
	.route("/:stack_id/services")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.get(async (req, res, next) => {
		try {
			const id = parseId(req.params.stack_id);
			const rows = await internalStack.services(res.locals.access, id);
			res.status(200).send(rows);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});


/**
 * Per-stack .env — GET/PUT /api/stacks/123/env
 */
router
	.route("/:stack_id/env")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.get(async (req, res, next) => {
		try {
			res.status(200).send(await internalStack.getEnv(res.locals.access, parseId(req.params.stack_id)));
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	})
	.put(async (req, res, next) => {
		try {
			const payload = await validator(
				{
					additionalProperties: false,
					properties: {
						content: { type: "string" },
						variables: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								required: ["name"],
								properties: { name: { type: "string" }, value: { type: "string" } },
							},
						},
					},
				},
				req.body,
			);
			res.status(200).send(await internalStack.setEnv(res.locals.access, parseId(req.params.stack_id), payload));
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * POST /api/stacks/123/terminal-ticket — mint a single-use ticket for the
 * terminal WebSocket. Authorisation happens here, over normal authenticated
 * REST, so the session JWT never has to travel in a WebSocket URL.
 */
router
	.route("/:stack_id/terminal-ticket")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.post(async (req, res, next) => {
		try {
			const payload = await validator(
				{
					additionalProperties: false,
					required: ["service"],
					properties: {
						service: { type: "string", minLength: 1, maxLength: 255 },
						shell: { type: "string", enum: ["sh", "bash"] },
					},
				},
				req.body,
			);
			const id = parseId(req.params.stack_id);
			// Throws unless the caller may open a shell in this stack; also gives us
			// the resolved compose dir, so the socket handler needs no further lookup.
			const target = await internalStack.execTarget(res.locals.access, id, payload.service);
			const { ticket, expiresIn } = issueTicket({
				service: payload.service,
				shell: payload.shell || "sh",
				target,
			});
			res.status(201).send({ ticket, expiresIn });
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * PUT /api/stacks/123/ignored-services — services to leave out of the status,
 * for one-shot init/migration containers that exit 0 by design.
 */
router
	.route("/:stack_id/ignored-services")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.put(async (req, res, next) => {
		try {
			const payload = await validator(
				{
					additionalProperties: false,
					required: ["services"],
					properties: {
						services: { type: "array", items: { type: "string", maxLength: 255 } },
					},
				},
				req.body,
			);
			res.status(200).send(
				await internalStack.setIgnoredServices(res.locals.access, parseId(req.params.stack_id), payload.services),
			);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * Expose a service as a TCP/UDP stream — POST /api/stacks/123/expose-stream
 */
router
	.route("/:stack_id/expose-stream")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.post(async (req, res, next) => {
		try {
			const payload = await validator(
				{
					additionalProperties: false,
					required: ["service", "port", "incoming_port"],
					properties: {
						service: { type: "string", minLength: 1 },
						port: { type: "integer", minimum: 1, maximum: 65535 },
						incoming_port: { type: "integer", minimum: 1, maximum: 65535 },
						tcp: { type: "boolean" },
						udp: { type: "boolean" },
						alias: { type: "string" },
					},
				},
				req.body,
			);
			const result = await internalStack.exposeStream(res.locals.access, {
				id: parseId(req.params.stack_id),
				...payload,
			});
			res.status(201).send(result);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * Expose a service — POST /api/stacks/123/expose
 * Creates a proxy host targeting the service over the comphost network.
 */
router
	.route("/:stack_id/expose")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.post(async (req, res, next) => {
		try {
			const id = parseId(req.params.stack_id);
			const payload = await validator(exposeSchema, req.body);
			const result = await internalStack.expose(res.locals.access, {
				id,
				service: payload.service,
				port: payload.port,
				domain_names: payload.domain_names,
				forward_scheme: payload.forward_scheme,
				ssl_forced: payload.ssl_forced,
				certificate: payload.certificate,
				certificate_id: payload.certificate_id,
				cloudflare: payload.cloudflare,
				access_list_id: payload.access_list_id,
				basic_auth: payload.basic_auth,
			});
			res.status(201).send(result);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * Streaming expose — POST /api/stacks/123/expose/stream
 * Same payload as /expose, but streams step progress as SSE (cert issuance can
 * take 30s+), ending with `event: done` carrying the created proxy host.
 */
router
	.route("/:stack_id/expose/stream")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.post(async (req, res, next) => {
		try {
			const id = parseId(req.params.stack_id);
			const payload = await validator(exposeSchema, req.body);

			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});
			const send = (msg) => {
				for (const line of String(msg).split(/\r?\n/)) {
					res.write(`data: ${line}\n`);
				}
				res.write("\n");
				res.flush?.();
			};

			try {
				const result = await internalStack.expose(
					res.locals.access,
					{
						id,
						service: payload.service,
						port: payload.port,
						domain_names: payload.domain_names,
						forward_scheme: payload.forward_scheme,
						ssl_forced: payload.ssl_forced,
						certificate: payload.certificate,
						certificate_id: payload.certificate_id,
						cloudflare: payload.cloudflare,
						access_list_id: payload.access_list_id,
						basic_auth: payload.basic_auth,
						alias: payload.alias,
					},
					send,
				);
				res.write(`event: done\ndata: ${JSON.stringify({ id: result.id })}\n\n`);
			} catch (err) {
				res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
			}
			res.end();
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			if (res.headersSent) {
				res.end();
			} else {
				next(err);
			}
		}
	});

/**
 * Live logs stream — GET /api/stacks/123/logs
 * Streams `docker compose logs -f` as Server-Sent Events. The frontend reads this
 * with fetch() (so it can send the Bearer header, which EventSource cannot).
 */
router
	.route("/:stack_id/logs")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.get(async (req, res, next) => {
		try {
			const id = parseId(req.params.stack_id);
			const { child } = await internalStack.logStream(res.locals.access, id);

			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				// no-transform tells the compression middleware (and proxies) NOT to
				// buffer/gzip this stream, which would defeat live streaming.
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});

			const send = (chunk) => {
				// SSE: prefix each line with "data: "
				const text = chunk.toString();
				for (const line of text.split(/\r?\n/)) {
					res.write(`data: ${line}\n`);
				}
				res.write("\n");
				res.flush?.();
			};
			child.stdout.on("data", send);
			child.stderr.on("data", send);
			child.on("close", () => {
				res.write("event: end\ndata: \n\n");
				res.end();
			});

			// Kill the compose logs process when the client disconnects.
			req.on("close", () => {
				child.kill("SIGTERM");
			});
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * Lifecycle actions — POST /api/stacks/123/<action>
 */
const lifecycleActions = {
	deploy: internalStack.deploy,
	down: internalStack.down,
	stop: internalStack.stop,
	restart: internalStack.restart,
	update: internalStack.updateStack,
};

/**
 * Streaming lifecycle — POST /api/stacks/123/stream/deploy
 * Same actions as below, but streams the live `docker compose` output as SSE so
 * the UI can show progress instead of blocking on a slow up/pull. Ends with an
 * `event: done` carrying the exit code.
 */
router
	.route("/:stack_id/stream/:action")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.post(async (req, res, next) => {
		try {
			const id = parseId(req.params.stack_id);
			const handler = lifecycleActions[req.params.action];
			if (!handler) {
				throw new errs.ValidationError(`Unknown action: ${req.params.action}`);
			}

			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				// no-transform stops the compression middleware buffering the stream.
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});

			const send = (chunk) => {
				for (const line of chunk.toString().split(/\r?\n/)) {
					res.write(`data: ${line}\n`);
				}
				res.write("\n");
				res.flush?.();
			};

			try {
				const result = await handler(res.locals.access, { id }, send);
				res.write(`event: done\ndata: ${JSON.stringify({ exitCode: result.exitCode })}\n\n`);
			} catch (err) {
				res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
			}
			res.end();
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			if (res.headersSent) {
				res.end();
			} else {
				next(err);
			}
		}
	});

for (const [action, handler] of Object.entries(lifecycleActions)) {
	router
		.route(`/:stack_id/${action}`)
		.options((_, res) => {
			res.sendStatus(204);
		})
		.all(jwtdecode())
		.post(async (req, res, next) => {
			try {
				const id = parseId(req.params.stack_id);
				const result = await handler(res.locals.access, { id });
				res.status(200).send(result);
			} catch (err) {
				debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
				next(err);
			}
		});
}

export default router;
