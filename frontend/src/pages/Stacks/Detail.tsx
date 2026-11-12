import {
	IconActivity,
	IconArrowLeft,
	IconArrowsLeftRight,
	IconArrowUp,
	IconDatabase,
	IconEdit,
	IconFileText,
	IconPlayerStop,
	IconRefresh,
	IconReload,
	IconTerminal2,
	IconVariable,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import Alert from "react-bootstrap/Alert";
import { Link, useParams } from "react-router-dom";
import { getStackServices, type StackAction } from "src/api/backend";
import { HasPermission, LoadingPage } from "src/components";
import { useStacks } from "src/hooks";
import { T } from "src/locale";
import {
	showStackActionModal,
	showStackConsoleModal,
	showStackEnvModal,
	showStackLogsModal,
	showStackModal,
	showStackMountsModal,
	showStackStatusModal,
	showStackStreamModal,
	showStackUpdatesModal,
} from "src/modals";
import { MANAGE, STACKS, VIEW } from "src/modules/Permissions";
import DomainsTable from "src/pages/Domains/TableWrapper";
import { StackStatus } from "./Table";

/** One stack: status, services, everything it's published as, and its actions. */
function StackDetail() {
	const id = Number(useParams().id);
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState(false);
	// The list call carries live status + update count; a single GET doesn't.
	const { data: stacks, isLoading, isError, error } = useStacks(["owner"]);
	const stack = stacks?.find((s) => s.id === id);
	const services = useQuery({
		queryKey: ["stack", id, "services"],
		queryFn: () => getStackServices(id),
		enabled: !!stack,
	});

	if (isLoading) return <LoadingPage />;
	if (isError) return <Alert variant="danger">{error?.message || "Unknown error"}</Alert>;
	if (!stack) {
		return (
			<Alert variant="warning" className="mt-4">
				<T id="stack.not-found" />
			</Alert>
		);
	}

	const act = async (action: StackAction) => {
		setBusy(true);
		try {
			await showStackActionModal(id, action);
		} finally {
			setBusy(false);
			queryClient.invalidateQueries({ queryKey: ["stacks"] });
			queryClient.invalidateQueries({ queryKey: ["stack", id] });
		}
	};
	const btn = (label: string, icon: React.ReactNode, onClick: () => void, extra = "") => (
		<button type="button" className={`btn btn-sm ${extra}`} disabled={busy} onClick={onClick}>
			<span className="me-1 d-inline-flex">{icon}</span>
			<T id={label} />
		</button>
	);

	return (
		<div className="mt-4">
			<div className="mb-3">
				<Link to="/stacks" className="text-secondary">
					<IconArrowLeft size={16} className="me-1" />
					<T id="stacks" />
				</Link>
			</div>
			<div className="d-flex flex-wrap align-items-center gap-2 mb-3">
				<h2 className="mb-0 me-2">{stack.name}</h2>
				{busy ? (
					<span className="text-secondary">
						<span className="spinner-border spinner-border-sm me-2" role="status" />
						<T id="stack.action.running" />
					</span>
				) : (
					<StackStatus status={stack.status} statusText={stack.statusText} />
				)}
				{(stack.updateCount ?? 0) > 0 && (
					<button
						type="button"
						className="badge bg-yellow text-dark border-0"
						onClick={() => showStackUpdatesModal(id)}
					>
						<IconRefresh size={11} className="me-1" />
						{stack.updateCount}
					</button>
				)}
			</div>

			<div className="btn-list mb-4">
				{btn("stack.action.logs", <IconFileText size={16} />, () => showStackLogsModal(id))}
				<HasPermission section={STACKS} permission={MANAGE} hideError>
					{btn("stack.action.deploy", <IconArrowUp size={16} />, () => act("deploy"), "btn-purple")}
					{btn("stack.action.restart", <IconReload size={16} />, () => act("restart"))}
					{btn("stack.action.stop", <IconPlayerStop size={16} />, () => act("stop"))}
					{btn("stack.action.down", <IconPlayerStop size={16} />, () => act("down"))}
					{btn("stack.action.update", <IconRefresh size={16} />, () => act("update"))}
					{btn("action.edit", <IconEdit size={16} />, () => showStackModal(id))}
					{btn("stack.action.env", <IconVariable size={16} />, () => showStackEnvModal(id))}
					{btn("stack.action.console", <IconTerminal2 size={16} />, () => showStackConsoleModal(id))}
					{btn("stack.action.stream", <IconArrowsLeftRight size={16} />, () => showStackStreamModal(id))}
					{btn("stack.action.mounts", <IconDatabase size={16} />, () => showStackMountsModal(id))}
					{btn("stack.action.check-updates", <IconRefresh size={16} />, () => showStackUpdatesModal(id))}
					{btn("stack.action.status-settings", <IconActivity size={16} />, () => showStackStatusModal(id))}
				</HasPermission>
			</div>

			<div className="card mb-4">
				<div className="card-header">
					<h3 className="card-title">
						<T id="stack.services" />
					</h3>
				</div>
				<div className="table-responsive">
					<table className="table table-vcenter card-table">
						<thead>
							<tr>
								<th>
									<T id="stack.expose.service" />
								</th>
								<th>
									<T id="column.status" />
								</th>
								<th>
									<T id="stack.expose.port" />
								</th>
								<th>
									<T id="stack.alias" />
								</th>
							</tr>
						</thead>
						<tbody>
							{services.isLoading ? (
								<tr>
									<td colSpan={4} className="text-secondary">
										<span className="spinner-border spinner-border-sm" role="status" />
									</td>
								</tr>
							) : (
								(services.data || []).map((s) => (
									<tr key={s.name}>
										<td className="fw-medium">{s.name}</td>
										<td>
											<span
												className={`badge ${String(s.state).includes("running") ? "bg-green-lt" : "bg-secondary-lt"}`}
											>
												{s.state || "—"}
											</span>
										</td>
										<td>{s.ports?.length ? s.ports.join(", ") : "—"}</td>
										<td className="text-secondary">
											{[
												...new Set([s.suggestedAlias, ...(s.aliases || [])].filter(Boolean)),
											].join(", ") || "—"}
										</td>
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>
			</div>

			<DomainsTable stackId={id} />
		</div>
	);
}

const Detail = () => (
	<HasPermission section={STACKS} permission={VIEW} pageLoading loadingNoLogo>
		<StackDetail />
	</HasPermission>
);

export default Detail;
