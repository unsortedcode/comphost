import { IconCheck, IconRefresh } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import EasyModal, { type InnerModalProps } from "ez-modal-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Alert } from "react-bootstrap";
import Modal from "react-bootstrap/Modal";
import { getStackUpdates, type ServiceUpdate } from "src/api/backend";
import { Button, Loading } from "src/components";
import { useStack } from "src/hooks";
import { T } from "src/locale";

const showStackUpdatesModal = (id: number) => EasyModal.show(StackUpdatesModal, { id });

interface Props extends InnerModalProps {
	id: number;
}

const shortDigest = (d?: string | null) => (d ? d.replace(/^sha256:/, "").slice(0, 12) : "—");

/**
 * Per-service image update check: compares the digest we're running against the
 * one the tag currently points at in the registry (no pull). Locally-built
 * services have nothing to compare and say so.
 */
const StackUpdatesModal = EasyModal.create(({ id, visible, remove, resolve }: Props) => {
	const queryClient = useQueryClient();
	const { data: stack } = useStack(id);
	const [rows, setRows] = useState<ServiceUpdate[] | null>(null);
	const [count, setCount] = useState(0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<ReactNode | null>(null);

	const check = useCallback(() => {
		setBusy(true);
		setError(null);
		return getStackUpdates(id)
			.then((r) => {
				setRows(r.updates);
				setCount(r.updateCount);
				// The backend caches the count on the row — refresh the list badge.
				queryClient.invalidateQueries({ queryKey: ["stacks"] });
			})
			.catch((e) => {
				setError(e.message);
				setRows([]);
			})
			.finally(() => setBusy(false));
	}, [id, queryClient]);

	useEffect(() => {
		check();
	}, [check]);

	const close = () => {
		resolve();
		remove();
	};

	return (
		<Modal show={visible} onHide={close} size="lg">
			<Modal.Header closeButton>
				<Modal.Title>
					<T id="stack.updates.title" />
					{stack?.name ? ` — ${stack.name}` : ""}
					{rows !== null && count > 0 && <span className="badge bg-yellow text-dark ms-2">{count}</span>}
				</Modal.Title>
			</Modal.Header>
			<Modal.Body>
				<Alert variant="danger" show={!!error} onClose={() => setError(null)} dismissible>
					{error}
				</Alert>

				{rows === null && <Loading noLogo />}

				{rows !== null && count === 0 && !error && (
					<Alert variant="success">
						<IconCheck size={16} className="me-1" />
						<T id="stack.updates.up-to-date" />
					</Alert>
				)}

				{!!rows?.length && (
					<table className="table table-sm align-middle">
						<thead>
							<tr>
								<th>
									<T id="stack.updates.service" />
								</th>
								<th>
									<T id="stack.updates.image" />
								</th>
								<th>
									<T id="stack.updates.running" />
								</th>
								<th>
									<T id="stack.updates.registry" />
								</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((r) => (
								<tr key={r.service}>
									<td>
										{r.service}
										{r.updateAvailable && (
											<span className="badge bg-yellow text-dark ms-2">
												<T id="stack.updates.available" />
											</span>
										)}
									</td>
									<td>
										<code className="small">{r.image || "—"}</code>
										{r.error && <div className="text-secondary small">{r.error}</div>}
									</td>
									<td className="font-monospace small">{shortDigest(r.local)}</td>
									<td className="font-monospace small">{shortDigest(r.remote)}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				{count > 0 && (
					<small className="form-hint">
						<T id="stack.updates.how-to-apply" />
					</small>
				)}
			</Modal.Body>
			<Modal.Footer>
				<Button onClick={check} isLoading={busy} disabled={busy}>
					<IconRefresh size={14} className="me-1" />
					<T id="stack.updates.recheck" />
				</Button>
				<Button className="ms-auto" onClick={close}>
					<T id="action.close" />
				</Button>
			</Modal.Footer>
		</Modal>
	);
});

export { showStackUpdatesModal };
