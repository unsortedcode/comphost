import { useQueryClient } from "@tanstack/react-query";
import EasyModal, { type InnerModalProps } from "ez-modal-react";
import { type ReactNode, useEffect, useState } from "react";
import { Alert } from "react-bootstrap";
import Modal from "react-bootstrap/Modal";
import { exposeStackStream, getStackServices, type StackService } from "src/api/backend";
import { Button } from "src/components";
import { useStack } from "src/hooks";
import { T } from "src/locale";
import { showObjectSuccess } from "src/notifications";

const showStackStreamModal = (id: number) => EasyModal.show(StackStreamModal, { id });

interface Props extends InnerModalProps {
	id: number;
}

/**
 * Expose a stack service over raw TCP/UDP (game servers, databases, anything not
 * HTTP). Uses the same comphost network alias as the HTTP expose flow, but creates
 * an nginx stream host instead of a proxy host.
 */
const StackStreamModal = EasyModal.create(({ id, visible, remove, resolve }: Props) => {
	const queryClient = useQueryClient();
	const { data: stack } = useStack(id);
	const [services, setServices] = useState<StackService[]>([]);
	const [service, setService] = useState("");
	const [port, setPort] = useState(0);
	const [incomingPort, setIncomingPort] = useState(0);
	const [tcp, setTcp] = useState(true);
	const [udp, setUdp] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<ReactNode | null>(null);

	useEffect(() => {
		getStackServices(id)
			.then((rows) => {
				setServices(rows || []);
				const running = rows?.find((s) => String(s.state).includes("running")) || rows?.[0];
				if (running) {
					setService(running.name);
					if (running.ports?.[0]) {
						setPort(running.ports[0]);
						setIncomingPort(running.ports[0]);
					}
				}
			})
			.catch(() => setServices([]));
	}, [id]);

	const onServiceChange = (name: string) => {
		setService(name);
		const svc = services.find((s) => s.name === name);
		if (svc?.ports?.[0]) {
			setPort(svc.ports[0]);
			setIncomingPort(svc.ports[0]);
		}
	};

	const submit = async () => {
		setError(null);
		if (!service || !port || !incomingPort) {
			setError("Service, container port and incoming port are all required");
			return;
		}
		if (!tcp && !udp) {
			setError("Pick at least one of TCP or UDP");
			return;
		}
		setBusy(true);
		try {
			await exposeStackStream(id, { service, port, incomingPort, tcp, udp });
			queryClient.invalidateQueries({ queryKey: ["streams"] });
			queryClient.invalidateQueries({ queryKey: ["stacks"] });
			queryClient.invalidateQueries({ queryKey: ["stack", id] });
			showObjectSuccess("stream", "saved");
			resolve();
			remove();
		} catch (e: any) {
			setError(e.message || "Failed to expose stream");
		}
		setBusy(false);
	};

	const close = () => {
		resolve();
		remove();
	};

	return (
		<Modal show={visible} onHide={close}>
			<Modal.Header closeButton>
				<Modal.Title>
					<T id="stack.stream.title" />
					{stack?.name ? ` — ${stack.name}` : ""}
				</Modal.Title>
			</Modal.Header>
			<Modal.Body>
				<Alert variant="danger" show={!!error} onClose={() => setError(null)} dismissible>
					{error}
				</Alert>
				<p className="text-secondary">
					<T id="stack.stream.help" />
				</p>

				<div className="mb-3">
					<label className="form-label">
						<T id="stack.expose.service" />
					</label>
					<select className="form-select" value={service} onChange={(e) => onServiceChange(e.target.value)}>
						{services.length === 0 && <option value="">(no services)</option>}
						{services.map((s) => (
							<option key={s.name} value={s.name}>
								{s.name} ({s.state})
							</option>
						))}
					</select>
				</div>

				<div className="row">
					<div className="col-6 mb-3">
						<label className="form-label">
							<T id="stack.stream.incoming-port" />
						</label>
						<input
							type="number"
							min={1}
							max={65535}
							className="form-control"
							value={incomingPort || ""}
							onChange={(e) => setIncomingPort(Number.parseInt(e.target.value, 10) || 0)}
						/>
						<small className="form-hint">
							<T id="stack.stream.incoming-hint" />
						</small>
					</div>
					<div className="col-6 mb-3">
						<label className="form-label">
							<T id="stack.expose.port" />
						</label>
						<input
							type="number"
							min={1}
							max={65535}
							className="form-control"
							value={port || ""}
							onChange={(e) => setPort(Number.parseInt(e.target.value, 10) || 0)}
						/>
					</div>
				</div>

				<label className="form-check form-check-inline">
					<input className="form-check-input" type="checkbox" checked={tcp} onChange={(e) => setTcp(e.target.checked)} />
					<span className="form-check-label">TCP</span>
				</label>
				<label className="form-check form-check-inline">
					<input className="form-check-input" type="checkbox" checked={udp} onChange={(e) => setUdp(e.target.checked)} />
					<span className="form-check-label">UDP</span>
				</label>
			</Modal.Body>
			<Modal.Footer>
				<Button onClick={close} disabled={busy}>
					<T id="cancel" />
				</Button>
				<Button actionType="primary" className="ms-auto" onClick={submit} isLoading={busy} disabled={busy}>
					<T id="stack.stream.submit" />
				</Button>
			</Modal.Footer>
		</Modal>
	);
});

export { showStackStreamModal };
