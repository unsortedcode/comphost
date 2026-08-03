import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";

interface Props {
	/** Called once the terminal is mounted; return a cleanup fn if needed. */
	onReady?: (term: Terminal, fit: FitAddon) => void | (() => void);
	/** Called on user input (keystrokes). */
	onData?: (data: string) => void;
	/** Called when the terminal is resized (after fit). */
	onResize?: (cols: number, rows: number) => void;
	readOnly?: boolean;
	minHeight?: number;
}

/**
 * Framework-agnostic xterm.js mounted in a React component. Handles fit-on-resize
 * and disposal. The parent drives content via the `onReady` terminal handle.
 */
export function Xterm({ onReady, onData, onResize, readOnly, minHeight = 360 }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!containerRef.current) return;

		const term = new Terminal({
			cursorBlink: !readOnly,
			disableStdin: !!readOnly,
			convertEol: true,
			fontSize: 13,
			fontFamily: "ui-monospace,SFMono-Regular,Consolas,Liberation Mono,Menlo,monospace",
			theme: { background: "#0d1117" },
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(containerRef.current);
		try {
			fit.fit();
		} catch {
			// container not laid out yet
		}

		if (onData) term.onData(onData);
		if (onResize) term.onResize(({ cols, rows }) => onResize(cols, rows));

		const cleanup = onReady?.(term, fit);

		const handleResize = () => {
			try {
				fit.fit();
			} catch {
				// ignore
			}
		};
		window.addEventListener("resize", handleResize);
		// Fit again shortly after mount (modal transition can change size).
		const t = setTimeout(handleResize, 150);

		return () => {
			window.removeEventListener("resize", handleResize);
			clearTimeout(t);
			if (typeof cleanup === "function") cleanup();
			term.dispose();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<div
			ref={containerRef}
			style={{ width: "100%", minHeight, background: "#0d1117", padding: 8, borderRadius: "0.3rem" }}
		/>
	);
}

export default Xterm;
