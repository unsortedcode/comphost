import type { Terminal } from "@xterm/xterm";
import EasyModal, { type InnerModalProps } from "ez-modal-react";
import { useRef } from "react";
import Modal from "react-bootstrap/Modal";
import { Button } from "src/components";
import { Xterm } from "src/components/Xterm/Xterm";
import { useStack } from "src/hooks";
import { T } from "src/locale";

const showStackLogsModal = (id: number) => {
	EasyModal.show(StackLogsModal, { id });
};

interface Props extends InnerModalProps {
	id: number;
}

const StackLogsModal = EasyModal.create(({ id, visible, remove }: Props) => {
	const { data } = useStack(id);
	const name = data?.name || "";
	const abortRef = useRef<AbortController | null>(null);

	const onReady = (term: Terminal) => {
		const controller = new AbortController();
		abortRef.current = controller;

		term.writeln(`\x1b[90mStreaming logs for ${name}…\x1b[0m`);

		fetch(`/api/stacks/${id}/logs`, {
			signal: controller.signal,
		})
			.then(async (res) => {
				if (!res.ok || !res.body) {
					term.writeln(`\x1b[31mFailed to open log stream (HTTP ${res.status})\x1b[0m`);
					return;
				}
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				// eslint-disable-next-line no-constant-condition
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						if (line.startsWith("data: ")) {
							term.writeln(line.slice(6));
						}
					}
				}
			})
			.catch((err) => {
				if (err.name !== "AbortError") {
					term.writeln(`\x1b[31m${err.message}\x1b[0m`);
				}
			});

		return () => controller.abort();
	};

	const close = () => {
		abortRef.current?.abort();
		remove();
	};

	return (
		<Modal show={visible} onHide={close} size="xl">
			<Modal.Header closeButton>
				<Modal.Title>
					<T id="stack.logs" /> — {name}
				</Modal.Title>
			</Modal.Header>
			<Modal.Body className="p-2">
				<Xterm onReady={onReady} readOnly minHeight={420} />
			</Modal.Body>
			<Modal.Footer>
				<Button onClick={close}>
					<T id="cancel" />
				</Button>
			</Modal.Footer>
		</Modal>
	);
});

export { showStackLogsModal };
