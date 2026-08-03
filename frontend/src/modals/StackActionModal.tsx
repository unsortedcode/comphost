import type { Terminal } from "@xterm/xterm";
import { useQueryClient } from "@tanstack/react-query";
import EasyModal, { type InnerModalProps } from "ez-modal-react";
import { useRef, useState } from "react";
import Modal from "react-bootstrap/Modal";
import type { StackAction } from "src/api/backend";
import { stackActionLabels } from "src/api/backend";
import { Button } from "src/components";
import { Xterm } from "src/components/Xterm/Xterm";
import { useStack } from "src/hooks";
import { T } from "src/locale";
import AuthStore from "src/modules/AuthStore";

/** Resolves when the modal is closed, so callers can clear their busy state. */
const showStackActionModal = (id: number, action: StackAction) =>
	EasyModal.show(StackActionModal, { params: { id, action } });

interface Props extends InnerModalProps {
	params: { id: number; action: StackAction };
}

/**
 * Runs a lifecycle action against the streaming endpoint and shows the live
 * `docker compose` output, so slow operations (up / pull) show progress instead
 * of a frozen menu. Stays open on completion so the result can be read.
 */
const StackActionModal = EasyModal.create(({ params, visible, remove, resolve }: Props) => {
	const { id, action } = params;
	const queryClient = useQueryClient();
	const { data: stack } = useStack(id);
	const [running, setRunning] = useState(true);
	const [exitCode, setExitCode] = useState<number | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	const onReady = (term: Terminal) => {
		const controller = new AbortController();
		abortRef.current = controller;

		term.writeln(`\x1b[90m${stackActionLabels[action]}…\x1b[0m`);

		fetch(`/api/stacks/${id}/stream/${action}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${AuthStore.token?.token}` },
			signal: controller.signal,
		})
			.then(async (res) => {
				if (!res.ok || !res.body) {
					term.writeln(`\x1b[31mFailed to start (HTTP ${res.status})\x1b[0m`);
					setRunning(false);
					return;
				}
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				let event = "";
				// eslint-disable-next-line no-constant-condition
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						if (line.startsWith("event: ")) {
							event = line.slice(7).trim();
						} else if (line.startsWith("data: ")) {
							const payload = line.slice(6);
							if (event === "done") {
								try {
									const { exitCode: code } = JSON.parse(payload);
									setExitCode(code);
									term.writeln(
										code === 0
											? "\x1b[32m✓ completed successfully\x1b[0m"
											: `\x1b[31m✗ exited with code ${code}\x1b[0m`,
									);
								} catch {
									// ignore
								}
								event = "";
							} else if (event === "error") {
								try {
									term.writeln(`\x1b[31m${JSON.parse(payload).message}\x1b[0m`);
								} catch {
									term.writeln(`\x1b[31m${payload}\x1b[0m`);
								}
								setExitCode(-1);
								event = "";
							} else {
								term.writeln(payload);
							}
						}
					}
				}
				setRunning(false);
				queryClient.invalidateQueries({ queryKey: ["stacks"] });
				queryClient.invalidateQueries({ queryKey: ["stack", id] });
			})
			.catch((err) => {
				if (err.name !== "AbortError") {
					term.writeln(`\x1b[31m${err.message}\x1b[0m`);
				}
				setRunning(false);
			});

		return () => controller.abort();
	};

	const close = () => {
		abortRef.current?.abort();
		queryClient.invalidateQueries({ queryKey: ["stacks"] });
		resolve();
		remove();
	};

	return (
		<Modal show={visible} onHide={close} size="lg" backdrop={running ? "static" : true}>
			<Modal.Header closeButton={!running}>
				<Modal.Title>
					{running && <span className="spinner-border spinner-border-sm me-2" role="status" />}
					{stackActionLabels[action]}
					{stack?.name ? ` — ${stack.name}` : ""}
					{!running && exitCode === 0 && <span className="badge bg-green text-white ms-2">done</span>}
					{!running && exitCode !== null && exitCode !== 0 && (
						<span className="badge bg-red text-white ms-2">failed</span>
					)}
				</Modal.Title>
			</Modal.Header>
			<Modal.Body className="p-2">
				<Xterm onReady={onReady} readOnly minHeight={320} />
			</Modal.Body>
			<Modal.Footer>
				<Button onClick={close} disabled={running}>
					<T id={running ? "stack.action.running" : "action.close"} />
				</Button>
			</Modal.Footer>
		</Modal>
	);
});

export { showStackActionModal };
