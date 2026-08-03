import type { Terminal } from "@xterm/xterm";
import EasyModal, { type InnerModalProps } from "ez-modal-react";
import { useEffect, useRef, useState } from "react";
import Modal from "react-bootstrap/Modal";
import { createTerminalTicket } from "src/api/backend";
import { Button } from "src/components";
import { Xterm } from "src/components/Xterm/Xterm";
import { useStack } from "src/hooks";
import { T } from "src/locale";
import AuthStore from "src/modules/AuthStore";

const showStackConsoleModal = (id: number) => {
	EasyModal.show(StackConsoleModal, { id });
};

interface Props extends InnerModalProps {
	id: number;
}

interface Service {
	name: string;
	state: string;
}

const StackConsoleModal = EasyModal.create(({ id, visible, remove }: Props) => {
	const { data } = useStack(id);
	const name = data?.name || "";
	const [services, setServices] = useState<Service[]>([]);
	const [service, setService] = useState<string>("");
	const [shell, setShell] = useState<string>("sh");
	const [connected, setConnected] = useState(false);
	const wsRef = useRef<WebSocket | null>(null);
	const termRef = useRef<Terminal | null>(null);

	// Load the stack's services for the picker.
	useEffect(() => {
		fetch(`/api/stacks/${id}/services`, {
			headers: { Authorization: `Bearer ${AuthStore.token?.token}` },
		})
			.then((r) => r.json())
			.then((rows: Service[]) => {
				setServices(rows || []);
				const running = rows?.find((s) => String(s.state).includes("running"));
				setService(running?.name || rows?.[0]?.name || "");
			})
			.catch(() => setServices([]));
	}, [id]);

	const disconnect = () => {
		wsRef.current?.close();
		wsRef.current = null;
		setConnected(false);
	};

	const onReady = (term: Terminal) => {
		termRef.current = term;
	};

	const connect = async () => {
		const term = termRef.current;
		if (!term || !service) return;
		disconnect();
		term.clear();

		// Spend the session token on a REST call and put the single-use ticket it
		// returns in the socket URL instead — a URL ends up in access logs and
		// browser history, and this credential opens a shell in the container.
		let ticket: string;
		try {
			ticket = (await createTerminalTicket(id, service, shell)).ticket;
		} catch (e: any) {
			term.writeln(`\r\n\x1b[31m[${e?.message || "could not start a session"}]\x1b[0m`);
			return;
		}

		const proto = window.location.protocol === "https:" ? "wss" : "ws";
		const url = `${proto}://${window.location.host}/api/stacks/terminal?ticket=${encodeURIComponent(ticket)}`;

		const ws = new WebSocket(url);
		wsRef.current = ws;
		ws.onopen = () => {
			setConnected(true);
			ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
		};
		ws.onmessage = (ev) => term.write(typeof ev.data === "string" ? ev.data : "");
		ws.onclose = () => setConnected(false);
		ws.onerror = () => term.writeln("\r\n\x1b[31m[connection error]\x1b[0m");

		term.onData((data) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: "input", data })));
		term.onResize(
			({ cols, rows }) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: "resize", cols, rows })),
		);
	};

	const close = () => {
		disconnect();
		remove();
	};

	return (
		<Modal show={visible} onHide={close} size="xl">
			<Modal.Header closeButton>
				<Modal.Title>
					<T id="stack.console" /> — {name}
				</Modal.Title>
			</Modal.Header>
			<Modal.Body className="p-2">
				<div className="d-flex gap-2 align-items-center mb-2">
					<select
						className="form-select form-select-sm w-auto"
						value={service}
						onChange={(e) => setService(e.target.value)}
					>
						{services.length === 0 && <option value="">(no running services)</option>}
						{services.map((s) => (
							<option key={s.name} value={s.name}>
								{s.name} ({s.state})
							</option>
						))}
					</select>
					<select
						className="form-select form-select-sm w-auto"
						value={shell}
						onChange={(e) => setShell(e.target.value)}
					>
						<option value="sh">sh</option>
						<option value="bash">bash</option>
					</select>
					<Button size="sm" className="btn-purple" onClick={connect} disabled={!service}>
						<T id={connected ? "stack.console.reconnect" : "stack.console.connect"} />
					</Button>
					{connected && <span className="badge bg-green text-white">●</span>}
				</div>
				<Xterm onReady={onReady} minHeight={420} />
			</Modal.Body>
			<Modal.Footer>
				<Button onClick={close}>
					<T id="cancel" />
				</Button>
			</Modal.Footer>
		</Modal>
	);
});

export { showStackConsoleModal };
