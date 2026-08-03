import { IconInfoCircle } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import EasyModal, { type InnerModalProps } from "ez-modal-react";
import { type ReactNode, useEffect, useState } from "react";
import { Alert } from "react-bootstrap";
import Modal from "react-bootstrap/Modal";
import { getStackServices, type StackService, setStackIgnoredServices } from "src/api/backend";
import { Button, Loading } from "src/components";
import { useStack } from "src/hooks";
import { T } from "src/locale";
import { showObjectSuccess } from "src/notifications";

const showStackStatusModal = (id: number) => EasyModal.show(StackStatusModal, { id });

interface Props extends InnerModalProps {
	id: number;
}

/**
 * Choose which services count towards a stack's status.
 *
 * A one-shot init or migration container exits 0 by design, which otherwise
 * leaves the whole stack reading Partial forever. Ignoring it here removes it
 * from the calculation without hiding it anywhere else.
 */
const StackStatusModal = EasyModal.create(({ id, visible, remove, resolve }: Props) => {
	const queryClient = useQueryClient();
	const { data: stack } = useStack(id);
	const [services, setServices] = useState<StackService[] | null>(null);
	const [ignored, setIgnored] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<ReactNode | null>(null);

	useEffect(() => {
		getStackServices(id)
			.then((rows) => setServices(rows || []))
			.catch((e) => {
				setError(e.message);
				setServices([]);
			});
	}, [id]);

	// Seed the checkboxes once the stack row (which carries the saved list) lands.
	useEffect(() => {
		if (stack?.ignoreServices) {
			setIgnored(stack.ignoreServices);
		}
	}, [stack?.ignoreServices]);

	const toggle = (name: string) =>
		setIgnored((list) => (list.includes(name) ? list.filter((n) => n !== name) : [...list, name]));

	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			await setStackIgnoredServices(id, ignored);
			queryClient.invalidateQueries({ queryKey: ["stacks"] });
			queryClient.invalidateQueries({ queryKey: ["stack", id] });
			showObjectSuccess("stack", "saved");
			resolve();
			remove();
		} catch (e: any) {
			setError(e.message || "Failed to save");
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
					<T id="stack.status-settings.title" />
					{stack?.name ? ` — ${stack.name}` : ""}
				</Modal.Title>
			</Modal.Header>
			<Modal.Body>
				<Alert variant="danger" show={!!error} onClose={() => setError(null)} dismissible>
					{error}
				</Alert>
				<p className="text-secondary">
					<T id="stack.status-settings.help" />
				</p>

				{services === null && <Loading noLogo />}
				{services?.length === 0 && (
					<p className="text-secondary">
						<T id="stack.status-settings.none" />
					</p>
				)}

				{services?.map((s) => (
					<label key={s.name} className="form-check">
						<input
							className="form-check-input"
							type="checkbox"
							checked={ignored.includes(s.name)}
							onChange={() => toggle(s.name)}
						/>
						<span className="form-check-label">
							{s.name}
							{s.state ? <span className="text-secondary ms-2 small">({s.state})</span> : null}
						</span>
					</label>
				))}

				{ignored.length > 0 && (
					<div className="text-secondary small mt-3">
						<IconInfoCircle size={14} className="me-1" />
						<T id="stack.status-settings.effect" data={{ count: ignored.length }} />
					</div>
				)}
			</Modal.Body>
			<Modal.Footer>
				<Button onClick={close} disabled={busy}>
					<T id="cancel" />
				</Button>
				<Button actionType="primary" className="ms-auto" onClick={save} isLoading={busy} disabled={busy}>
					<T id="save" />
				</Button>
			</Modal.Footer>
		</Modal>
	);
});

export { showStackStatusModal };
