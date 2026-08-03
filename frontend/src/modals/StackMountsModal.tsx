import { IconDatabase, IconFolder } from "@tabler/icons-react";
import EasyModal, { type InnerModalProps } from "ez-modal-react";
import { type ReactNode, useEffect, useState } from "react";
import { Alert } from "react-bootstrap";
import Modal from "react-bootstrap/Modal";
import {
	type BackupTarget,
	getBackupTargets,
	getStackMounts,
	type MountBackupConfig,
	setStackMounts,
} from "src/api/backend";
import { Button, Loading } from "src/components";
import { useStack } from "src/hooks";
import { T } from "src/locale";
import { showObjectSuccess } from "src/notifications";

const showStackMountsModal = (id: number) => EasyModal.show(StackMountsModal, { id });

interface Props extends InnerModalProps {
	id: number;
}

/**
 * Per-mount backup configuration: every named volume and bind mount of a stack
 * gets its own target and method. Named volumes default to a tar snapshot; bind
 * mounts default to rsync (incremental, preserves layout) when the path is
 * readable from CompHost.
 */
const StackMountsModal = EasyModal.create(({ id, visible, remove, resolve }: Props) => {
	const { data: stack } = useStack(id);
	const [mounts, setMounts] = useState<MountBackupConfig[] | null>(null);
	const [targets, setTargets] = useState<BackupTarget[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<ReactNode | null>(null);

	useEffect(() => {
		Promise.all([getStackMounts(id), getBackupTargets()])
			.then(([m, t]) => {
				setMounts(m);
				setTargets(t);
			})
			.catch((e) => {
				setError(e.message);
				setMounts([]);
			});
	}, [id]);

	const patch = (source: string, changes: Partial<MountBackupConfig>) =>
		setMounts((ms) => (ms || []).map((m) => (m.source === source ? { ...m, ...changes } : m)));

	const save = async () => {
		if (!mounts) return;
		setBusy(true);
		setError(null);
		try {
			const saved = await setStackMounts(
				id,
				mounts.map((m) => ({
					kind: m.kind,
					source: m.source,
					targetId: m.targetId,
					method: m.method,
					enabled: m.enabled,
				})),
			);
			setMounts(saved);
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

	return (
		<Modal show={visible} onHide={close} size="xl">
			<Modal.Header closeButton>
				<Modal.Title>
					<T id="stack.mounts.title" />
					{stack?.name ? ` — ${stack.name}` : ""}
				</Modal.Title>
			</Modal.Header>
			<Modal.Body>
				<Alert variant="danger" show={!!error} onClose={() => setError(null)} dismissible>
					{error}
				</Alert>
				<p className="text-secondary">
					<T id="stack.mounts.help" />
				</p>

				{mounts === null && <Loading noLogo />}
				{mounts?.length === 0 && (
					<p className="text-secondary">
						<T id="stack.mounts.none" />
					</p>
				)}

				{!!mounts?.length && (
					<table className="table table-sm align-middle">
						<thead>
							<tr>
								<th>
									<T id="stack.mounts.backup" />
								</th>
								<th>
									<T id="stack.mounts.source" />
								</th>
								<th>
									<T id="stack.mounts.target" />
								</th>
								<th>
									<T id="stack.mounts.method" />
								</th>
							</tr>
						</thead>
						<tbody>
							{mounts.map((m) => (
								<tr key={m.source}>
									<td className="w-1">
										<input
											className="form-check-input m-0"
											type="checkbox"
											checked={m.enabled}
											onChange={(e) => patch(m.source, { enabled: e.target.checked })}
										/>
									</td>
									<td>
										{m.kind === "volume" ? (
											<IconDatabase size={14} className="me-1 text-blue" />
										) : (
											<IconFolder size={14} className="me-1 text-yellow" />
										)}
										<code className="small">{m.source}</code>
										{m.destination && <span className="text-secondary small"> → {m.destination}</span>}
									</td>
									<td>
										<select
											className="form-select form-select-sm"
											value={m.targetId}
											onChange={(e) => patch(m.source, { targetId: Number.parseInt(e.target.value, 10) })}
											disabled={!m.enabled}
										>
											<option value={0}>(use the target chosen at backup time)</option>
											{targets.map((t) => (
												<option key={t.id} value={t.id}>
													{t.name} ({t.type.toUpperCase()})
												</option>
											))}
										</select>
									</td>
									<td style={{ width: 210 }}>
										<select
											className="form-select form-select-sm"
											value={m.method}
											onChange={(e) => patch(m.source, { method: e.target.value as "tar" | "rsync" })}
											disabled={!m.enabled}
										>
											<option value="tar">tar snapshot</option>
											<option value="rsync" disabled={!m.rsyncAvailable}>
												rsync {m.rsyncAvailable ? "(incremental)" : "(path not visible)"}
											</option>
										</select>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</Modal.Body>
			<Modal.Footer>
				<Button onClick={close} disabled={busy}>
					<T id="cancel" />
				</Button>
				<Button actionType="primary" className="ms-auto" onClick={save} isLoading={busy} disabled={busy || !mounts?.length}>
					<T id="save" />
				</Button>
			</Modal.Footer>
		</Modal>
	);
});

export { showStackMountsModal };
