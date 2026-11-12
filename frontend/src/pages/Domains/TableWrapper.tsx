import { IconSearch } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import Alert from "react-bootstrap/Alert";
import { useSearchParams } from "react-router-dom";
import { type DomainKind, type DomainRow, linkDomainHost } from "src/api/backend";
import { HasPermission, LoadingPage } from "src/components";
import { useDomains } from "src/hooks";
import { intl, T } from "src/locale";
import { showDeleteConfirmModal, showStackExposeModal } from "src/modals";
import { MANAGE, STACKS } from "src/modules/Permissions";
import { showObjectSuccess, showSuccess } from "src/notifications";
import { KIND, needsAttention, SECTION_OF } from "./kinds";
import Table from "./Table";

const KINDS: DomainKind[] = ["proxy", "redirect", "dead", "stream"];
const SSL_STATES = ["none", "valid", "expiring", "expired"];

interface Props {
	/** Embedded on a stack's page: only that stack's domains, no stack filter, no URL state */
	stackId?: number;
}

export default function TableWrapper({ stackId }: Props) {
	const queryClient = useQueryClient();
	const [params, setParams] = useSearchParams();
	const { isFetching, isLoading, isError, error, data } = useDomains();
	const embedded = stackId !== undefined;

	// Filters live in the URL so the dashboard and stack pages can link to a view.
	const filter = {
		type: embedded ? "" : params.get("type") || "",
		ssl: embedded ? "" : params.get("ssl") || "",
		stack: embedded ? String(stackId) : params.get("stack") || "",
		attention: !embedded && params.get("attention") === "1",
		q: embedded ? "" : (params.get("q") || "").toLowerCase(),
	};
	const setFilter = (key: string, value: string) => {
		const next = new URLSearchParams(params);
		if (value) next.set(key, value);
		else next.delete(key);
		setParams(next, { replace: true });
	};

	const rows = data ?? [];
	const stacks = useMemo(() => {
		const map = new Map<number, string>();
		for (const r of rows) if (r.stack) map.set(r.stack.id, r.stack.name);
		return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
	}, [rows]);
	const hostDomainCount = useMemo(() => {
		const map = new Map<string, number>();
		for (const r of rows) map.set(`${r.kind}-${r.hostId}`, (map.get(`${r.kind}-${r.hostId}`) ?? 0) + 1);
		return map;
	}, [rows]);

	if (isLoading) {
		return <LoadingPage />;
	}
	if (isError) {
		return <Alert variant="danger">{error?.message || "Unknown error"}</Alert>;
	}

	const filtered = rows.filter(
		(r) =>
			(!filter.type || r.kind === filter.type) &&
			(!filter.ssl || r.sslState === filter.ssl) &&
			(!filter.stack || String(r.stack?.id ?? "") === filter.stack) &&
			(!filter.attention || needsAttention(r)) &&
			(!filter.q ||
				r.domain.toLowerCase().includes(filter.q) ||
				r.target.toLowerCase().includes(filter.q) ||
				(r.stack?.name ?? "").toLowerCase().includes(filter.q)),
	);
	const isFiltered = embedded ? false : !!(filter.type || filter.ssl || filter.stack || filter.attention || filter.q);
	const attentionCount = rows.filter(needsAttention).length;

	const domainsOfHost = (row: DomainRow) =>
		rows.filter((r) => r.kind === row.kind && r.hostId === row.hostId).map((r) => r.domain);

	const handleToggle = async (row: DomainRow) => {
		const k = KIND[row.kind];
		await k.toggle(row.hostId, !row.enabled);
		queryClient.invalidateQueries({ queryKey: [k.queryKeys[0]] });
		showObjectSuccess(k.object, row.enabled ? "disabled" : "enabled");
	};

	const handleDelete = (row: DomainRow) => {
		const k = KIND[row.kind];
		showDeleteConfirmModal({
			title: <T id="object.delete" tData={{ object: k.object }} />,
			onConfirm: async () => {
				await k.remove(row.hostId);
				showObjectSuccess(k.object, "deleted");
			},
			invalidations: [[k.queryKeys[0]], [k.queryKeys[1], row.hostId], ["stacks"]],
			children: (
				<>
					<T id="object.delete.content" tData={{ object: k.object }} />
					<div className="mt-2 fw-bold text-break">{domainsOfHost(row).join(", ")}</div>
					<div className="mt-1 text-muted small">{row.target}</div>
				</>
			),
		});
	};

	const handleLink = async (row: DomainRow, link: boolean) => {
		if (row.kind !== "proxy" && row.kind !== "stream") return;
		const s = row.linkSuggestion;
		await linkDomainHost(row.kind, row.hostId, link && s ? s.stackId : 0, link ? s?.service : undefined);
		queryClient.invalidateQueries({ queryKey: ["stacks"] });
		showSuccess(
			intl.formatMessage(
				{ id: link ? "domains.linked" : "domains.unlinked" },
				{ domains: domainsOfHost(row).join(", "), stack: (link ? s?.stackName : row.stack?.name) ?? "" },
			),
		);
	};

	const addMenu = (
		<span className="dropdown">
			<button type="button" className="btn btn-sm btn-lime dropdown-toggle" data-bs-toggle="dropdown">
				<T id="action.add" />
			</button>
			<div className="dropdown-menu dropdown-menu-end">
				<HasPermission section={STACKS} permission={MANAGE} hideError>
					<a
						className="dropdown-item"
						href="#"
						onClick={(e) => {
							e.preventDefault();
							showStackExposeModal(stackId ?? 0);
						}}
					>
						<T id="domains.add.expose" />
					</a>
					<div className="dropdown-divider" />
				</HasPermission>
				{KINDS.map((kind) => (
					<HasPermission key={kind} section={SECTION_OF[kind]} permission={MANAGE} hideError>
						<a
							className="dropdown-item"
							href="#"
							onClick={(e) => {
								e.preventDefault();
								KIND[kind].edit("new");
							}}
						>
							<T id={KIND[kind].object} />
						</a>
					</HasPermission>
				))}
			</div>
		</span>
	);

	const select = (key: string, value: string, options: [string, string][]) => (
		<select
			className="form-select form-select-sm w-auto"
			value={value}
			onChange={(e) => setFilter(key, e.target.value)}
		>
			{options.map(([v, label]) => (
				<option key={v} value={v}>
					{label}
				</option>
			))}
		</select>
	);

	const table = (
		<Table
			data={filtered}
			hostDomainCount={hostDomainCount}
			isFiltered={isFiltered}
			isFetching={isFetching}
			hideStack={embedded}
			onEdit={(row) => KIND[row.kind].edit(row.hostId)}
			onToggle={handleToggle}
			onDelete={handleDelete}
			onLink={(row) => handleLink(row, true)}
			onUnlink={(row) => handleLink(row, false)}
			onNew={() => (embedded ? showStackExposeModal(stackId) : KIND.proxy.edit("new"))}
		/>
	);

	if (embedded) {
		return (
			<div className="card">
				<div className="card-header">
					<h3 className="card-title">
						<T id="domains" />
					</h3>
					<div className="card-actions">{addMenu}</div>
				</div>
				<div className="card-table">{table}</div>
			</div>
		);
	}

	const all = intl.formatMessage({ id: "filter.all" });
	return (
		<div className="card mt-4">
			<div className="card-status-top bg-lime" />
			<div className="card-table">
				<div className="card-header">
					<div className="row w-full g-2 align-items-center">
						<div className="col">
							<h2 className="mt-1 mb-0">
								<T id="domains" />
							</h2>
						</div>
						<div className="col-md-auto col-sm-12">
							<div className="ms-auto d-flex flex-wrap btn-list align-items-center">
								<div className="input-group input-group-flat w-auto">
									<span className="input-group-text input-group-text-sm">
										<IconSearch size={16} />
									</span>
									<input
										type="text"
										className="form-control form-control-sm"
										autoComplete="off"
										defaultValue={params.get("q") || ""}
										onChange={(e) => setFilter("q", e.target.value.trim())}
									/>
								</div>
								{select("type", filter.type, [
									["", `${intl.formatMessage({ id: "column.type" })}: ${all}`],
									...KINDS.map((k): [string, string] => [
										k,
										intl.formatMessage({ id: `host-kind.${k}` }),
									]),
								])}
								{select("ssl", filter.ssl, [
									["", `${intl.formatMessage({ id: "column.ssl" })}: ${all}`],
									...SSL_STATES.map((s): [string, string] => [
										s,
										intl.formatMessage({ id: `ssl-state.filter.${s}` }),
									]),
								])}
								{stacks.length
									? select("stack", filter.stack, [
											["", `${intl.formatMessage({ id: "stack" })}: ${all}`],
											...stacks.map(([id, name]): [string, string] => [String(id), name]),
										])
									: null}
								<button
									type="button"
									className={`btn btn-sm ${filter.attention ? "btn-orange" : ""}`}
									onClick={() => setFilter("attention", filter.attention ? "" : "1")}
								>
									<T id="domains.needs-attention" data={{ count: attentionCount }} />
								</button>
								{addMenu}
							</div>
						</div>
					</div>
				</div>
				{table}
			</div>
		</div>
	);
}
