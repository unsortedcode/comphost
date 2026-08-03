import EasyModal, { type InnerModalProps } from "ez-modal-react";
import { type ReactNode, useEffect, useState } from "react";
import { Alert } from "react-bootstrap";
import Modal from "react-bootstrap/Modal";
import { useQueryClient } from "@tanstack/react-query";
import { exposeStackStreaming, getStackServices, type StackService } from "src/api/backend";
import { Button } from "src/components";
import { useStack } from "src/hooks";
import { T } from "src/locale";
import AuthStore from "src/modules/AuthStore";
import { showObjectSuccess } from "src/notifications";

const showStackExposeModal = (id: number) => {
	EasyModal.show(StackExposeModal, { id });
};

interface Props extends InnerModalProps {
	id: number;
}

const StackExposeModal = EasyModal.create(({ id, visible, remove }: Props) => {
	const queryClient = useQueryClient();
	const { data: stack } = useStack(id);
	const [services, setServices] = useState<StackService[]>([]);
	const [service, setService] = useState("");
	const [port, setPort] = useState<number>(80);
	const [domain, setDomain] = useState("");
	const [scheme, setScheme] = useState("http");
	const [requestCert, setRequestCert] = useState(false);
	const [useCloudflare, setUseCloudflare] = useState(false);
	const [useBasicAuth, setUseBasicAuth] = useState(false);
	const [authUser, setAuthUser] = useState("");
	const [authPass, setAuthPass] = useState("");
	const [errorMsg, setErrorMsg] = useState<ReactNode | null>(null);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<string[]>([]);

	useEffect(() => {
		getStackServices(id)
			.then((rows) => {
				setServices(rows || []);
				const running = rows?.find((s) => String(s.state).includes("running")) || rows?.[0];
				if (running) {
					setService(running.name);
					if (running.ports?.[0]) setPort(running.ports[0]);
				}
			})
			.catch(() => setServices([]));
	}, [id]);

	const onServiceChange = (name: string) => {
		setService(name);
		const svc = services.find((s) => s.name === name);
		if (svc?.ports?.[0]) setPort(svc.ports[0]);
	};

	const submit = async () => {
		setErrorMsg(null);
		const domainNames = domain
			.split(",")
			.map((d) => d.trim())
			.filter(Boolean);
		if (!service || !port || domainNames.length === 0) {
			setErrorMsg("Service, port and at least one domain are required");
			return;
		}
		if (useBasicAuth && (!authUser || !authPass)) {
			setErrorMsg("Basic auth needs a username and password");
			return;
		}
		setBusy(true);
		setProgress([]);
		try {
			await exposeStackStreaming(
				id,
				{
					service,
					port,
					domainNames,
					forwardScheme: scheme,
					certificate: requestCert ? "new" : undefined,
					cloudflare: useCloudflare || undefined,
					basicAuth: useBasicAuth ? { username: authUser, password: authPass } : undefined,
				},
				(line) => setProgress((p) => [...p, line]),
				AuthStore.token?.token || "",
			);
			queryClient.invalidateQueries({ queryKey: ["proxy-hosts"] });
			queryClient.invalidateQueries({ queryKey: ["stacks"] });
			showObjectSuccess("proxy-host", "saved");
			remove();
		} catch (err: any) {
			setErrorMsg(err.message || "Failed to expose service");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal show={visible} onHide={remove}>
			<Modal.Header closeButton>
				<Modal.Title>
					<T id="stack.expose.title" /> {stack?.name ? `— ${stack.name}` : ""}
				</Modal.Title>
			</Modal.Header>
			<Modal.Body>
				<Alert variant="danger" show={!!errorMsg} onClose={() => setErrorMsg(null)} dismissible>
					{errorMsg}
				</Alert>
				<p className="text-secondary">
					<T id="stack.expose.help" />
				</p>

				<div className="row">
					<div className="col-8 mb-3">
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
						{services.find((s) => s.name === service)?.suggestedAlias && (
							<small className="form-hint">
								<T id="stack.expose.target" />{" "}
								<code>{services.find((s) => s.name === service)?.suggestedAlias}:{port}</code>
							</small>
						)}
					</div>
					<div className="col-4 mb-3">
						<label className="form-label">
							<T id="stack.expose.port" />
						</label>
						<input
							type="number"
							min={1}
							max={65535}
							className="form-control"
							value={port}
							onChange={(e) => setPort(Number.parseInt(e.target.value, 10))}
						/>
					</div>
				</div>

				<div className="mb-3">
					<label className="form-label">
						<T id="stack.expose.domains" />
					</label>
					<input
						type="text"
						className="form-control"
						placeholder="app.example.com"
						value={domain}
						onChange={(e) => setDomain(e.target.value)}
					/>
					<small className="form-hint">
						<T id="stack.expose.domains.hint" />
					</small>
				</div>

				<div className="mb-3">
					<label className="form-label">
						<T id="stack.expose.scheme" />
					</label>
					<select className="form-select" value={scheme} onChange={(e) => setScheme(e.target.value)}>
						<option value="http">http</option>
						<option value="https">https</option>
					</select>
				</div>

					<hr />

					<label className="form-check">
						<input className="form-check-input" type="checkbox" checked={requestCert} onChange={(e) => setRequestCert(e.target.checked)} />
						<span className="form-check-label"><T id="stack.expose.ssl" /></span>
					</label>
					<label className="form-check">
						<input className="form-check-input" type="checkbox" checked={useCloudflare} onChange={(e) => setUseCloudflare(e.target.checked)} />
						<span className="form-check-label"><T id="stack.expose.cloudflare" /></span>
					</label>
					<label className="form-check">
						<input className="form-check-input" type="checkbox" checked={useBasicAuth} onChange={(e) => setUseBasicAuth(e.target.checked)} />
						<span className="form-check-label"><T id="stack.expose.basic-auth" /></span>
					</label>
					{useBasicAuth && (
						<div className="row mt-2">
							<div className="col-6">
								<input type="text" className="form-control" placeholder="username" autoComplete="off" value={authUser} onChange={(e) => setAuthUser(e.target.value)} />
							</div>
							<div className="col-6">
								<input type="password" className="form-control" placeholder="password" autoComplete="new-password" value={authPass} onChange={(e) => setAuthPass(e.target.value)} />
							</div>
						</div>
					)}

					{progress.length > 0 && (
						<div className="mt-3">
							<label className="form-label small mb-1">
								{busy && <span className="spinner-border spinner-border-sm me-2" role="status" />}
								<T id="stack.expose.progress" />
							</label>
							<pre className="p-2 mb-0 small" style={{ maxHeight: 160, overflowY: "auto", background: "var(--tblr-bg-surface-dark)", borderRadius: "0.3rem" }}>
								{progress.map((line) => `${line}\n`).join("")}
							</pre>
						</div>
					)}
			</Modal.Body>
			<Modal.Footer>
				<Button onClick={remove} disabled={busy}>
					<T id="cancel" />
				</Button>
				<Button actionType="primary" className="ms-auto" onClick={submit} isLoading={busy} disabled={busy}>
					<T id="stack.expose.submit" />
				</Button>
			</Modal.Footer>
		</Modal>
	);
});

export { showStackExposeModal };
