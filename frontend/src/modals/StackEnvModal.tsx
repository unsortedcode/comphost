import { IconAlertTriangle } from "@tabler/icons-react";
import EasyModal, { type InnerModalProps } from "ez-modal-react";
import { type ReactNode, useEffect, useState } from "react";
import { Alert } from "react-bootstrap";
import Modal from "react-bootstrap/Modal";
import { getStackEnv, setStackEnv, type StackEnvVariable } from "src/api/backend";
import { Button, Loading } from "src/components";
import { useStack } from "src/hooks";
import { T } from "src/locale";
import { showObjectSuccess } from "src/notifications";

const showStackEnvModal = (id: number) => EasyModal.show(StackEnvModal, { id });

interface Props extends InnerModalProps {
	id: number;
}

/**
 * Per-stack .env editor. Rather than a blank text box, it lists the variables the
 * compose file actually references (with their inline defaults) and flags any that
 * compose expects but .env doesn't define.
 */
const StackEnvModal = EasyModal.create(({ id, visible, remove, resolve }: Props) => {
	const { data: stack } = useStack(id);
	const [vars, setVars] = useState<StackEnvVariable[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<ReactNode | null>(null);

	useEffect(() => {
		getStackEnv(id)
			.then((r) => setVars(r.variables))
			.catch((e) => {
				setError(e.message);
				setVars([]);
			});
	}, [id]);

	const patch = (name: string, value: string) =>
		setVars((vs) => (vs || []).map((v) => (v.name === name ? { ...v, value } : v)));

	const save = async () => {
		if (!vars) return;
		setBusy(true);
		setError(null);
		try {
			const res = await setStackEnv(id, { variables: vars.map((v) => ({ name: v.name, value: v.value })) });
			setVars(res.variables);
			showObjectSuccess("stack", "saved");
		} catch (e: any) {
			setError(e.message || "Save failed");
		}
		setBusy(false);
	};

	const close = () => {
		resolve();
		remove();
	};

	const missing = (vars || []).filter((v) => v.missing).length;

	return (
		<Modal show={visible} onHide={close} size="lg">
			<Modal.Header closeButton>
				<Modal.Title>
					<T id="stack.env.title" />
					{stack?.name ? ` — ${stack.name}` : ""}
				</Modal.Title>
			</Modal.Header>
			<Modal.Body>
				<Alert variant="danger" show={!!error} onClose={() => setError(null)} dismissible>
					{error}
				</Alert>
				<p className="text-secondary">
					<T id="stack.env.help" />
				</p>
				{missing > 0 && (
					<Alert variant="warning">
						<IconAlertTriangle size={16} className="me-1" />
						<T id="stack.env.missing-warning" data={{ count: missing }} />
					</Alert>
				)}

				{vars === null && <Loading noLogo />}
				{vars?.length === 0 && (
					<p className="text-secondary">
						<T id="stack.env.none" />
					</p>
				)}

				{!!vars?.length && (
					<table className="table table-sm align-middle">
						<thead>
							<tr>
								<th>
									<T id="stack.env.variable" />
								</th>
								<th>
									<T id="stack.env.value" />
								</th>
							</tr>
						</thead>
						<tbody>
							{vars.map((v) => (
								<tr key={v.name}>
									<td style={{ width: "40%" }}>
										<code className="small">{v.name}</code>
										{!v.usedInCompose && (
											<span className="badge bg-secondary text-white ms-2" title="only in .env">
												<T id="stack.env.unused" />
											</span>
										)}
										{v.missing && (
											<div className="text-warning small">
												<T id="stack.env.missing" />
												{v.defaultValue ? ` (default: ${v.defaultValue})` : ""}
											</div>
										)}
									</td>
									<td>
										<input
											className="form-control form-control-sm font-monospace"
											value={v.value}
											placeholder={v.defaultValue || ""}
											onChange={(e) => patch(v.name, e.target.value)}
										/>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<small className="form-hint">
					<T id="stack.env.redeploy-hint" />
				</small>
			</Modal.Body>
			<Modal.Footer>
				<Button onClick={close} disabled={busy}>
					<T id="cancel" />
				</Button>
				<Button actionType="primary" className="ms-auto" onClick={save} isLoading={busy} disabled={busy || !vars?.length}>
					<T id="save" />
				</Button>
			</Modal.Footer>
		</Modal>
	);
});

export { showStackEnvModal };
