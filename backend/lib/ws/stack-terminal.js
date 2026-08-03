// WebSocket endpoint for interactive stack terminals (container exec).
// Clients connect to /api/stacks/terminal; nginx strips the /api prefix (proxy_pass
// with a trailing slash), so the backend listens on /stacks/terminal.
// Query: ?token=<jwt>&stack=<id>&service=<name>&shell=<sh|bash>
//
// Browser WebSocket cannot set an Authorization header, so the JWT is passed as a
// query param and verified here via the same Access/Token machinery as REST.
//
// Wire protocol:
//   client -> server: JSON { type: "input", data } | { type: "resize", cols, rows }
//   server -> client: raw pty output (text frames)

import { WebSocketServer } from "ws";
import { express as logger } from "../../logger.js";
import Access from "../access.js";
import orchestrator from "../compose/orchestrator.js";
import { PtyTerminal } from "../compose/terminal.js";
import internalStack from "../../internal/stack.js";

// Backend path AFTER nginx strips /api. Frontend connects to /api/stacks/terminal.
const WS_PATH = "/stacks/terminal";

export function attachStackTerminal(server) {
	const wss = new WebSocketServer({ server, path: WS_PATH });

	wss.on("connection", async (ws, req) => {
		let terminal = null;
		try {
			const url = new URL(req.url, "http://localhost");
			const token = url.searchParams.get("token");
			const id = Number.parseInt(url.searchParams.get("stack") || "", 10);
			const service = url.searchParams.get("service") || "";
			const shell = url.searchParams.get("shell") || "sh";

			if (!token || Number.isNaN(id) || !service) {
				ws.close(1008, "Missing token, stack or service");
				return;
			}

			// Authenticate + authorize using the same machinery as the REST layer.
			const access = new Access(token);
			await access.load();
			const target = await internalStack.execTarget(access, id, service);

			// Spawn: docker compose exec <service> <shell>
			const args = orchestrator.getComposeOptions(target.dir, target.stacksDir, "exec", service, shell);
			terminal = new PtyTerminal("docker", args, { cwd: target.dir });

			terminal.on("data", (data) => {
				if (ws.readyState === ws.OPEN) {
					ws.send(data);
				}
			});
			terminal.on("exit", (code) => {
				if (ws.readyState === ws.OPEN) {
					ws.send(`\r\n[process exited with code ${code}]\r\n`);
					ws.close();
				}
			});
			terminal.start();

			ws.on("message", (raw) => {
				let msg;
				try {
					msg = JSON.parse(raw.toString());
				} catch {
					return;
				}
				if (msg.type === "input") {
					terminal.write(msg.data);
				} else if (msg.type === "resize") {
					terminal.resize(msg.cols, msg.rows);
				}
			});

			ws.on("close", () => terminal?.kill());
			ws.on("error", () => terminal?.kill());
		} catch (err) {
			logger.error(`Stack terminal WS error: ${err.message}`);
			try {
				ws.send(`\r\n[error: ${err.message}]\r\n`);
			} catch {
				// ignore
			}
			terminal?.kill();
			ws.close(1011, "Terminal error");
		}
	});

	logger.info(`Stack terminal WebSocket listening on ${WS_PATH}`);
	return wss;
}

export default attachStackTerminal;
