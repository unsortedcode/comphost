// Thin node-pty wrapper, EventEmitter-based (no socket.io coupling — that was the
// Dockge design; here the WS layer subscribes to events). Ported concept from
// Dockge backend/terminal.ts.

import { EventEmitter } from "node:events";
import pty from "@homebridge/node-pty-prebuilt-multiarch";

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;

export class PtyTerminal extends EventEmitter {
	/**
	 * @param {string}   file  executable (e.g. "docker")
	 * @param {string[]} args
	 * @param {object}   opts  { cwd, cols, rows, env }
	 */
	constructor(file, args, opts = {}) {
		super();
		this.file = file;
		this.args = args;
		this.cwd = opts.cwd;
		this.cols = opts.cols || DEFAULT_COLS;
		this.rows = opts.rows || DEFAULT_ROWS;
		this.env = { ...process.env, UV_USE_IO_URING: "0", ...(opts.env || {}) };
		this.ptyProcess = null;
	}

	start() {
		this.ptyProcess = pty.spawn(this.file, this.args, {
			name: "xterm-256color",
			cwd: this.cwd,
			cols: this.cols,
			rows: this.rows,
			env: this.env,
		});
		this.ptyProcess.onData((data) => this.emit("data", data));
		this.ptyProcess.onExit(({ exitCode }) => this.emit("exit", exitCode));
		return this;
	}

	write(data) {
		this.ptyProcess?.write(data);
	}

	resize(cols, rows) {
		if (!this.ptyProcess) return;
		this.cols = cols || this.cols;
		this.rows = rows || this.rows;
		try {
			this.ptyProcess.resize(this.cols, this.rows);
		} catch {
			// ignore resize errors on a dead pty
		}
	}

	kill() {
		try {
			this.ptyProcess?.kill();
		} catch {
			// already dead
		}
	}
}

export default PtyTerminal;
