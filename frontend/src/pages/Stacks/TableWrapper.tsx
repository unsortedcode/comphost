import { IconHelp, IconSearch } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import Alert from "react-bootstrap/Alert";
import { deleteStack, type StackAction } from "src/api/backend";
import { Button, HasPermission, LoadingPage } from "src/components";
import { useStacks } from "src/hooks";
import { T } from "src/locale";
import {
	showDeleteConfirmModal,
	showHelpModal,
	showStackActionModal,
	showStackAdoptModal,
	showStackConsoleModal,
	showStackEnvModal,
	showStackExposeModal,
	showStackLogsModal,
	showStackModal,
	showStackMountsModal,
	showStackStatusModal,
	showStackStreamModal,
	showStackUpdatesModal,
} from "src/modals";
import { MANAGE, STACKS } from "src/modules/Permissions";
import { showObjectSuccess } from "src/notifications";
import Table from "./Table";

export default function TableWrapper() {
	const queryClient = useQueryClient();
	const [search, setSearch] = useState("");
	const [busyId, setBusyId] = useState(0);
	const { isFetching, isLoading, isError, error, data } = useStacks(["owner"]);

	if (isLoading) {
		return <LoadingPage />;
	}

	if (isError) {
		return <Alert variant="danger">{error?.message || "Unknown error"}</Alert>;
	}

	const invalidate = (id: number) => {
		queryClient.invalidateQueries({ queryKey: ["stacks"] });
		queryClient.invalidateQueries({ queryKey: ["stack", id] });
	};

	const handleDelete = async (id: number) => {
		await deleteStack(id);
		showObjectSuccess("stack", "deleted");
	};

	// Lifecycle ops can take minutes (pull/up), so run them in a modal that streams
	// the live docker compose output instead of blocking with no feedback. The
	// modal resolves on close, which clears the row spinner.
	const handleAction = async (id: number, action: StackAction) => {
		setBusyId(id);
		try {
			await showStackActionModal(id, action);
		} finally {
			setBusyId(0);
			invalidate(id);
		}
	};

	let filtered = null;
	if (search && data) {
		filtered = data?.filter((item) => item.name.includes(search));
	} else if (search !== "") {
		setSearch("");
	}

	return (
		<div className="card mt-4">
			<div className="card-status-top bg-purple" />
			<div className="card-table">
				<div className="card-header">
					<div className="row w-full">
						<div className="col">
							<h2 className="mt-1 mb-0">
								<T id="stacks" />
							</h2>
						</div>
						<div className="col-md-auto col-sm-12">
							<div className="ms-auto d-flex flex-wrap btn-list">
								{data?.length ? (
									<div className="input-group input-group-flat w-auto">
										<span className="input-group-text input-group-text-sm">
											<IconSearch size={16} />
										</span>
										<input
											id="advanced-table-search"
											type="text"
											className="form-control form-control-sm"
											autoComplete="off"
											onChange={(e: any) => setSearch(e.target.value.toLowerCase().trim())}
										/>
									</div>
								) : null}
								<HasPermission section={STACKS} permission={MANAGE} hideError>
									<Button size="sm" onClick={() => showStackAdoptModal()}>
										<T id="stack.adopt.action" />
									</Button>
								</HasPermission>
								<Button size="sm" onClick={() => showHelpModal("Stacks", "purple")}>
									<IconHelp size={20} />
								</Button>
								<HasPermission section={STACKS} permission={MANAGE} hideError>
									{data?.length ? (
										<Button size="sm" className="btn-purple" onClick={() => showStackModal("new")}>
											<T id="object.add" tData={{ object: "stack" }} />
										</Button>
									) : null}
								</HasPermission>
							</div>
						</div>
					</div>
				</div>
				<Table
					data={filtered ?? data ?? []}
					isFetching={isFetching}
					isFiltered={!!filtered}
					busyId={busyId}
					onEdit={(id: number) => showStackModal(id)}
					onAction={handleAction}
					onLogs={(id: number) => showStackLogsModal(id)}
					onConsole={(id: number) => showStackConsoleModal(id)}
					onExpose={(id: number) => showStackExposeModal(id)}
					onMounts={(id: number) => showStackMountsModal(id)}
					onEnv={(id: number) => showStackEnvModal(id)}
					onStream={(id: number) => showStackStreamModal(id)}
					onUpdates={(id: number) => showStackUpdatesModal(id)}
					onStatusSettings={(id: number) => showStackStatusModal(id)}
					onDelete={(id: number) =>
						showDeleteConfirmModal({
							title: <T id="object.delete" tData={{ object: "stack" }} />,
							onConfirm: () => handleDelete(id),
							invalidations: [["stacks"], ["stack", id]],
							children: <T id="object.delete.content" tData={{ object: "stack" }} />,
						})
					}
					onNew={() => showStackModal("new")}
				/>
			</div>
		</div>
	);
}
