import {
	IconAlertTriangle,
	IconBrandDocker,
	IconDotsVertical,
	IconEdit,
	IconExternalLink,
	IconLink,
	IconLinkOff,
	IconPower,
	IconTrash,
} from "@tabler/icons-react";
import {
	createColumnHelper,
	getCoreRowModel,
	getSortedRowModel,
	type SortingState,
	useReactTable,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { DomainRow } from "src/api/backend";
import { EmptyData, HasPermission, HostKindFormatter, SslStateFormatter } from "src/components";
import { TableLayout } from "src/components/Table/TableLayout";
import { intl, T } from "src/locale";
import { MANAGE, type Section, STACKS } from "src/modules/Permissions";
import { needsAttention, SECTION_OF } from "./kinds";

interface Props {
	data: DomainRow[];
	/** How many domains each host serves, keyed `${kind}-${hostId}` */
	hostDomainCount: Map<string, number>;
	isFiltered?: boolean;
	isFetching?: boolean;
	hideStack?: boolean;
	onEdit: (row: DomainRow) => void;
	onToggle: (row: DomainRow) => void;
	onDelete: (row: DomainRow) => void;
	onLink: (row: DomainRow) => void;
	onUnlink: (row: DomainRow) => void;
	onNew?: () => void;
}

/** http(s) link to the domain itself — wildcards and stream ports have none. */
const hrefOf = (row: DomainRow) => {
	if (row.kind === "stream" || row.domain.includes("*")) return null;
	return `${row.certificate ? "https" : "http"}://${row.domain}`;
};

export default function Table({
	data,
	hostDomainCount,
	isFiltered,
	isFetching,
	hideStack,
	onEdit,
	onToggle,
	onDelete,
	onLink,
	onUnlink,
	onNew,
}: Props) {
	const columnHelper = createColumnHelper<DomainRow>();
	const columns = useMemo(
		() => [
			columnHelper.accessor((row) => row.domain, {
				id: "domain",
				header: intl.formatMessage({ id: "column.domain" }),
				cell: (info) => {
					const row = info.row.original;
					const href = hrefOf(row);
					const others = (hostDomainCount.get(`${row.kind}-${row.hostId}`) ?? 1) - 1;
					return (
						<div>
							<span className={row.enabled ? "fw-medium" : "text-secondary text-decoration-line-through"}>
								{row.domain}
							</span>
							{href ? (
								<a href={href} target="_blank" rel="noreferrer" className="ms-1 text-secondary">
									<IconExternalLink size={14} />
								</a>
							) : null}
							{others > 0 ? (
								<div className="small text-secondary">
									<T id="domains.shared-host" data={{ count: others }} />
								</div>
							) : null}
						</div>
					);
				},
			}),
			columnHelper.accessor((row) => row.kind, {
				id: "kind",
				header: intl.formatMessage({ id: "column.type" }),
				cell: (info) => <HostKindFormatter kind={info.getValue()} />,
			}),
			columnHelper.accessor((row) => row.stack?.name ?? row.target, {
				id: "target",
				header: intl.formatMessage({ id: "column.destination" }),
				cell: (info) => {
					const row = info.row.original;
					if (row.stack && !hideStack) {
						return (
							<div>
								<Link to={`/stacks/${row.stack.id}`} className="fw-medium">
									<IconBrandDocker size={14} className="me-1" />
									{row.stack.name}
									{row.stack.service ? ` ▸ ${row.stack.service}` : ""}
								</Link>
								<div className="small text-secondary">{row.target}</div>
							</div>
						);
					}
					return (
						<div>
							{/* On a stack's own page the stack is implied; the service still matters */}
							{row.stack?.service ? <div className="fw-medium">{row.stack.service}</div> : null}
							<span
								className={
									row.kind === "dead"
										? "text-secondary"
										: row.stack
											? "small text-secondary"
											: undefined
								}
							>
								{row.target}
							</span>
							{row.linkSuggestion ? (
								<div className="small text-orange">
									<T
										id="domains.link-suggestion"
										data={{
											stack: row.linkSuggestion.stackName ?? `#${row.linkSuggestion.stackId}`,
											service: row.linkSuggestion.service,
										}}
									/>
								</div>
							) : null}
						</div>
					);
				},
			}),
			columnHelper.accessor((row) => row.sslState, {
				id: "ssl",
				header: intl.formatMessage({ id: "column.ssl" }),
				cell: (info) => {
					const row = info.row.original;
					if (row.kind === "dead" && !row.certificate) return <span className="text-secondary">—</span>;
					return (
						<SslStateFormatter
							state={row.sslState}
							expiresOn={row.certificate?.expiresOn}
							title={row.certificate?.niceName}
						/>
					);
				},
			}),
			columnHelper.accessor((row) => needsAttention(row), {
				id: "status",
				header: intl.formatMessage({ id: "column.status" }),
				cell: (info) => {
					const row = info.row.original;
					if (!row.enabled) {
						return (
							<span className="badge bg-secondary-lt">
								<T id="disabled" />
							</span>
						);
					}
					const problems = [
						!row.online ? intl.formatMessage({ id: "domains.problem.offline" }) : null,
						...row.drift.filter((d) => !d.repaired).map((d) => d.message),
					].filter(Boolean);
					const repaired = row.drift.filter((d) => d.repaired);
					if (problems.length) {
						return (
							<span
								className="badge bg-red-lt"
								title={[row.nginxErr, ...problems].filter(Boolean).join("\n")}
							>
								<IconAlertTriangle size={12} className="me-1" />
								<T id="domains.problem" data={{ count: problems.length }} />
							</span>
						);
					}
					return (
						<>
							<span className="badge bg-green-lt">
								<T id="online" />
							</span>
							{repaired.length ? (
								<span
									className="badge bg-blue-lt ms-1"
									title={repaired.map((d) => d.message).join("\n")}
								>
									<T id="domains.repaired" />
								</span>
							) : null}
						</>
					);
				},
			}),
			columnHelper.display({
				id: "actions",
				cell: (info) => {
					const row = info.row.original;
					const section: Section = SECTION_OF[row.kind];
					const linkable = row.kind === "proxy" || row.kind === "stream";
					const item = (
						onClick: () => void,
						icon: React.ReactNode,
						label: string,
						data?: Record<string, string | number | undefined>,
					) => (
						<a
							className="dropdown-item"
							href="#"
							onClick={(e) => {
								e.preventDefault();
								onClick();
							}}
						>
							{icon}
							<T id={label} data={data} />
						</a>
					);
					return (
						<span className="dropdown">
							<button
								type="button"
								className="btn dropdown-toggle btn-action btn-sm px-1"
								data-bs-boundary="viewport"
								data-bs-toggle="dropdown"
							>
								<IconDotsVertical />
							</button>
							<div className="dropdown-menu dropdown-menu-end">
								<span className="dropdown-header">{row.domain}</span>
								{item(() => onEdit(row), <IconEdit size={16} />, "action.edit")}
								{row.stack && !hideStack ? (
									<Link className="dropdown-item" to={`/stacks/${row.stack.id}`}>
										<IconBrandDocker size={16} />
										<T id="domains.open-stack" />
									</Link>
								) : null}
								<HasPermission section={section} permission={MANAGE} hideError>
									<HasPermission section={STACKS} permission={MANAGE} hideError>
										{linkable && row.linkSuggestion
											? item(() => onLink(row), <IconLink size={16} />, "domains.link", {
													stack: row.linkSuggestion.stackName ?? undefined,
												})
											: null}
										{linkable && row.stack
											? item(() => onUnlink(row), <IconLinkOff size={16} />, "domains.unlink")
											: null}
									</HasPermission>
									{item(
										() => onToggle(row),
										<IconPower size={16} />,
										row.enabled ? "action.disable" : "action.enable",
									)}
									<div className="dropdown-divider" />
									{item(() => onDelete(row), <IconTrash size={16} />, "action.delete")}
								</HasPermission>
							</div>
						</span>
					);
				},
				meta: { className: "text-end w-1" },
			}),
		],
		[columnHelper, hostDomainCount, hideStack, onEdit, onToggle, onDelete, onLink, onUnlink],
	);

	const [sorting, setSorting] = useState<SortingState>([]);

	const tableInstance = useReactTable<DomainRow>({
		columns,
		data,
		state: { sorting },
		onSortingChange: setSorting,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		rowCount: data.length,
		meta: { isFetching },
		enableSortingRemoval: false,
	});

	return (
		<TableLayout
			tableInstance={tableInstance}
			emptyState={
				<EmptyData
					object="domain"
					objects="domains"
					tableInstance={tableInstance}
					onNew={onNew}
					isFiltered={isFiltered}
					color="lime"
				/>
			}
		/>
	);
}
