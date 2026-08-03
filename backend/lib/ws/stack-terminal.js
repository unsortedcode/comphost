// WebSocket endpoint for interactive stack terminals (container exec).
// Clients connect to /api/stacks/terminal; nginx strips the /api prefix (proxy_pass
// with a trailing slash), so the backend listens on /stacks/terminal.
// Query: ?ticket=<opaque>
//
// A browser WebSocket cannot set an Authorization header, so the credential has
// to be in the URL — where nginx logs it, the browser keeps it in history, and
// it can leak via Referer. The session JWT therefore never appears here. The
// client first POSTs to /api/stacks/:id/terminal-ticket (authenticated the
// normal way), and spends the single-use, 30-second ticket it gets back.
//
// Wire protocol:
//   client -> server: JSON { type: "input", data } | { type: "resize", cols, rows }
//   server -> client: raw pty output (text frames)

import { WebSocketServer } from "ws";
import { express as logger } from "../../logger.js";
import orchestrator from "../compose/orchestrator.js";
import { PtyTerminal } from "../compose/terminal.js";
import { consumeTicket } from "./ticket.js";

// Backend path AFTER nginx strips /api. Frontend connects to /api/stacks/terminal.
const WS_PATH = "/stacks/terminal";

export function attachStackTerminal(server) {
	const wss = new WebSocketServer({ server, path: WS_PATH });

	wss.on("connection", async (ws, req) => {
		let terminal = null;
		try {
			const url = new URL(req.url, "http://localhost");
			// Authorisation happened when the ticket was issued; redeeming it here
			// both authenticates the connection and tells us what it may open.
			const grant = consumeTicket(url.searchParams.get("ticket"));
			if (!grant) {
				ws.close(1008, "Invalid or expired ticket");
				return;
			}
			const { service, shell, target } = grant;

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
