import {
	IconAlertTriangle,
	IconArrowUp,
	IconDownload,
	IconFileText,
	IconFolder,
	IconFolderOpen,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import EasyModal, { type InnerModalProps } from "ez-modal-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Alert } from "react-bootstrap";
import Modal from "react-bootstrap/Modal";
import { adoptStack, type BrowseResult, browseStackDirs, type DiscoveredStack, discoverStacks } from "src/api/backend";
import { Button, Loading } from "src/components";
import { T } from "src/locale";
import { showObjectSuccess } from "src/notifications";

const showStackAdoptModal = () => EasyModal.show(StackAdoptModal, {});

type Props = InnerModalProps;

/** Directory names are freeform; stack names are not. */
const suggestName = (dirName: string) =>
	dirName
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");

/**
 * Adopt compose projects already running on this host — the migration path for a
 * box that was running plain docker compose (e.g. alongside stock NPM) before
 * CompHost. Nothing is moved: the stack is registered in place.
 *
 * Two ways in: the Detected tab lists what `docker compose ls` knows about, and
 * the Browse tab walks the filesystem for projects that are currently down and
 * therefore invisible to discovery.
 */
const StackAdoptModal = EasyModal.create(({ visible, remove, resolve }: Props) => {
	const queryClient = useQueryClient();
	const [tab, setTab] = useState<"detected" | "browse">("detected");
	const [rows, setRows] = useState<DiscoveredStack[] | null>(null);
	const [busy, setBusy] = useState("");
	const [error, setError] = useState<ReactNode | null>(null);
	const [adopted, setAdopted] = useState<string[]>([]);

	// Browse tab state. pathInput is what's typed in the path bar; dir is what's
	// actually loaded — keeping them apart stops a half-typed path from being
	// paired with the previously loaded directory's compose file.
	const [dir, setDir] = useState<BrowseResult | null>(null);
	const [pathInput, setPathInput] = useState("");
	const [loadingDir, setLoadingDir] = useState(false);
	const [selected, setSelected] = useState<{ path: string; name: string } | null>(null);

	useEffect(() => {
		discoverStacks()
			.then(setRows)
			.catch((e) => {
				setError(e.message);
				setRows([]);
			});
	}, []);

	const go = useCallback((to?: string) => {
		setLoadingDir(true);
		setError(null);
		setSelected(null);
		browseStackDirs(to)
			.then((res) => {
				setDir(res);
				setPathInput(res.path);
			})
			.catch((e) => setError(e.message))
			.finally(() => setLoadingDir(false));
	}, []);

	const openBrowse = () => {
		setTab("browse");
		if (!dir) {
			go();
		}
	};

	const adopt = async (name: string, composeDir: string, key: string) => {
		setBusy(key);
		setError(null);
		try {
			await adoptStack(name, composeDir);
			setAdopted((a) => [...a, key]);
			setSelected(null);
			queryClient.invalidateQueries({ queryKey: ["stacks"] });
			showObjectSuccess("stack", "saved");
			if (tab === "browse") {
				go(dir?.path); // refresh "managed" flags
			}
		} catch (e: any) {
			setError(e.message || "Adoption failed");
		}
		setBusy("");
	};

	const close = () => {
		resolve();
		remove();
	};

	return (
		<Modal show={visible} onHide={close} size="lg">
			<Modal.Header closeButton>
				<Modal.Title>
					<T id="stack.adopt.title" />
				</Modal.Title>
			</Modal.Header>
			<Modal.Body>
				<Alert variant="danger" show={!!error} onClose={() => setError(null)} dismissible>
					{error}
				</Alert>

				<ul className="nav nav-tabs mb-3">
					<li className="nav-item">
						<button
							type="button"
							className={`nav-link ${tab === "detected" ? "active" : ""}`}
							onClick={() => setTab("detected")}
						>
							<T id="stack.adopt.tab.detected" />
						</button>
					</li>
					<li className="nav-item">
						<button
							type="button"
							className={`nav-link ${tab === "browse" ? "active" : ""}`}
							onClick={openBrowse}
						>
							<T id="stack.adopt.tab.browse" />
						</button>
					</li>
				</ul>

				{tab === "detected" ? (
					<>
						<p className="text-secondary">
							<T id="stack.adopt.help" />
						</p>

						{rows === null && <Loading noLogo />}
						{rows?.length === 0 && (
							<p className="text-secondary">
								<T id="stack.adopt.none" />
							</p>
						)}

						{!!rows?.length && (
							<table className="table table-sm">
								<thead>
									<tr>
										<th>Project</th>
										<th>Status</th>
										<th>Compose file</th>
										<th />
									</tr>
								</thead>
								<tbody>
									{rows.map((r) => (
										<tr key={r.name}>
											<td>{r.name}</td>
											<td className="text-secondary">{r.status}</td>
											<td>
												<code className="small">{r.composeFile || "—"}</code>
												{!r.readable && (
													<div className="text-warning small">
														<IconAlertTriangle size={13} className="me-1" />
														<T id="stack.adopt.not-visible" />
													</div>
												)}
											</td>
											<td className="text-end">
												{adopted.includes(r.name) ? (
													<span className="badge bg-green text-white">
														<T id="stack.adopt.done" />
													</span>
												) : (
													<Button
														size="sm"
														className="btn-purple"
														onClick={() => adopt(r.name, r.composeDir, r.name)}
														isLoading={busy === r.name}
														disabled={!!busy || !r.readable}
													>
														<IconDownload size={14} className="me-1" />
														<T id="stack.adopt.action" />
													</Button>
												)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</>
				) : (
					<>
						<p className="text-secondary">
							<T id="stack.adopt.browse-help" />
						</p>

						<div className="input-group input-group-flat mb-2">
							<span className="input-group-text">
								<IconFolderOpen size={16} />
							</span>
							<input
								type="text"
								className="form-control font-monospace"
								value={pathInput}
								placeholder={dir?.stacksDir}
								onChange={(e) => setPathInput(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										go(pathInput);
									}
								}}
							/>
							<span className="input-group-text">
								<button
									type="button"
									className="btn btn-sm btn-ghost-secondary"
									onClick={() => go(pathInput)}
								>
									<T id="stack.adopt.browse-go" />
								</button>
							</span>
						</div>

						{loadingDir && <Loading noLogo />}

						{!loadingDir && dir && (
							<>
								<div
									className="list-group list-group-flush border rounded mb-3"
									style={{ maxHeight: 260, overflowY: "auto" }}
								>
									{dir.parent && (
										<button
											type="button"
											className="list-group-item list-group-item-action d-flex align-items-center"
											onClick={() => go(dir.parent as string)}
										>
											<IconArrowUp size={16} className="me-2 flex-shrink-0" />
											<span className="font-monospace">..</span>
										</button>
									)}
									{dir.entries.length === 0 && (
										<div className="list-group-item text-secondary">
											<T id="stack.adopt.browse-empty" />
										</div>
									)}
									{dir.entries.map((e) => (
										<div key={e.path} className="list-group-item d-flex align-items-center">
											<button
												type="button"
												className="btn btn-link p-0 text-decoration-none d-flex align-items-center text-reset flex-grow-1 text-start"
												onClick={() => go(e.path)}
											>
												<IconFolder size={16} className="me-2 flex-shrink-0" />
												<span className="text-break">{e.name}</span>
											</button>
											{e.composeFile && (
												<span className="badge bg-blue-lt ms-2 flex-shrink-0">
													<IconFileText size={12} className="me-1" />
													{e.composeFile}
												</span>
											)}
											{e.managed ? (
												<span className="badge bg-secondary ms-2 flex-shrink-0">
													<T id="stack.adopt.managed" />
												</span>
											) : e.composeFile ? (
												<Button
													size="sm"
													className="btn-purple ms-2 flex-shrink-0"
													onClick={() =>
														setSelected({ path: e.path, name: suggestName(e.name) })
													}
												>
													<T id="stack.adopt.select" />
												</Button>
											) : null}
										</div>
									))}
								</div>

								{dir.truncated && (
									<p className="text-secondary small">
										<T id="stack.adopt.browse-truncated" />
									</p>
								)}

								{/* Adopting the directory we're standing in. */}
								{dir.composeFile && !dir.managed && !selected && (
									<Button
										className="btn-purple mb-3"
										onClick={() =>
											setSelected({
												path: dir.path,
												name: suggestName(dir.path.split(/[\\/]/).filter(Boolean).pop() || ""),
											})
										}
									>
										<IconDownload size={14} className="me-1" />
										<T
											id="stack.adopt.use-current"
											tData={{ file: dir.composeFile }}
											data={{ file: dir.composeFile }}
										/>
									</Button>
								)}

								{selected && (
									<div className="card">
										<div className="card-body">
											<div className="mb-2">
												<code className="small text-break">{selected.path}</code>
											</div>
											<label className="form-label" htmlFor="adopt-stack-name">
												<T id="stack.name" />
											</label>
											<input
												id="adopt-stack-name"
												type="text"
												className="form-control mb-1"
												value={selected.name}
												onChange={(ev) => setSelected({ ...selected, name: ev.target.value })}
											/>
											<small className="form-hint">
												<T id="stack.adopt.name-hint" />
											</small>
											<div className="btn-list mt-3">
												<Button onClick={() => setSelected(null)} disabled={!!busy}>
													<T id="cancel" />
												</Button>
												<Button
													className="btn-purple ms-auto"
													onClick={() => adopt(selected.name, selected.path, selected.path)}
													isLoading={busy === selected.path}
													disabled={!!busy || !/^[a-z0-9_-]+$/.test(selected.name)}
												>
													<IconDownload size={14} className="me-1" />
													<T id="stack.adopt.action" />
												</Button>
											</div>
										</div>
									</div>
								)}
							</>
						)}
					</>
				)}
			</Modal.Body>
			<Modal.Footer>
				<Button onClick={close}>
					<T id="action.close" />
				</Button>
			</Modal.Footer>
		</Modal>
	);
});

export { showStackAdoptModal };
