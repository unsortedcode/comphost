import {
	IconArrowUp,
	IconDotsVertical,
	IconEdit,
	IconDatabase,
	IconLock,
	IconActivity,
	IconArrowsLeftRight,
	IconVariable,
	IconFileText,
	IconWorld,
	IconPlayerStop,
	IconRefresh,
	IconReload,
	IconTerminal2,
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
import type { Stack, StackAction } from "src/api/backend";
import { EmptyData, GravatarFormatter, HasPermission, ValueWithDateFormatter } from "src/components";
import { TableLayout } from "src/components/Table/TableLayout";
import { intl, T } from "src/locale";
import { MANAGE, STACKS } from "src/modules/Permissions";

// Status code (see backend lib/compose/constants.js) -> label id + badge color.
const STATUS_META: Record<number, { label: string; color: string }> = {
	0: { label: "stack.status.unknown", color: "bg-secondary" },
	1: { label: "stack.status.draft", color: "bg-secondary" },
	2: { label: "stack.status.created", color: "bg-yellow" },
	3: { label: "stack.status.running", color: "bg-green" },
	4: { label: "stack.status.exited", color: "bg-red" },
	5: { label: "stack.status.partial", color: "bg-orange" },
};

function StackStatus({ status, statusText }: { status: number; statusText?: string | null }) {
	const meta = STATUS_META[status] ?? STATUS_META[0];
	// compose's own wording ("exited(1), running(2)") explains why a stack reads
	// Partial or Exited — worth surfacing rather than making the user go digging.
	return (
		<span className={`badge ${meta.color} text-white`} title={statusText || undefined}>
			<T id={meta.label} />
		</span>
	);
}

interface Props {
	data: Stack[];
	isFiltered?: boolean;
	isFetching?: boolean;
	busyId?: number;
	onEdit?: (id: number) => void;
	onDelete?: (id: number) => void;
	onAction?: (id: number, action: StackAction) => void;
	onLogs?: (id: number) => void;
	onConsole?: (id: number) => void;
	onExpose?: (id: number) => void;
	onMounts?: (id: number) => void;
	onEnv?: (id: number) => void;
	onStream?: (id: number) => void;
	onUpdates?: (id: number) => void;
	onStatusSettings?: (id: number) => void;
	onNew?: () => void;
}

export default function Table({
	data,
	isFetching,
	isFiltered,
	busyId,
	onEdit,
	onDelete,
	onAction,
	onLogs,
	onConsole,
	onExpose,
	onMounts,
	onEnv,
	onStream,
	onUpdates,
	onStatusSettings,
	onNew,
}: Props) {
	const columnHelper = createColumnHelper<Stack>();
	const columns = useMemo(
		() => [
			columnHelper.accessor((row: any) => row.owner, {
				id: "owner",
				enableSorting: false,
				cell: (info: any) => {
					const value = info.getValue();
					return <GravatarFormatter url={value ? value.avatar : ""} name={value ? value.name : ""} />;
				},
				meta: { className: "w-1" },
			}),
			columnHelper.accessor((row: any) => row, {
				id: "name",
				header: intl.formatMessage({ id: "stack.name" }),
				sortingFn: (a, b) => a.original.name.localeCompare(b.original.name),
				cell: (info: any) => {
					const value = info.getValue();
					return <ValueWithDateFormatter value={value.name} createdOn={value.createdOn} />;
				},
			}),
			columnHelper.accessor((row: any) => row, {
				id: "status",
				header: intl.formatMessage({ id: "column.status" }),
				cell: (info: any) => {
					const row: Stack = info.getValue();
					// While a lifecycle op runs, show progress instead of a stale status.
					if (busyId === row.id) {
						return (
							<span className="text-secondary">
								<span className="spinner-border spinner-border-sm me-2" role="status" />
								<T id="stack.action.running" />
							</span>
						);
					}
					return (
						<>
							<StackStatus status={row.status} statusText={row.statusText} />
							{(row.updateCount ?? 0) > 0 && (
								<button
									type="button"
									className="badge bg-yellow text-dark ms-2 border-0"
									title={intl.formatMessage({ id: "stack.updates.available" })}
									onClick={() => onUpdates?.(row.id)}
								>
									<IconRefresh size={11} className="me-1" />
									{row.updateCount}
								</button>
							)}
						</>
					);
				},
			}),
			columnHelper.accessor((row: any) => row, {
				id: "exposures",
				header: intl.formatMessage({ id: "stack.exposures" }),
				enableSorting: false,
				cell: (info: any) => {
					const row: Stack = info.getValue();
					const list = row.exposures || [];
					if (!list.length) {
						return <span className="text-secondary">—</span>;
					}
					return (
						<div className="d-flex flex-column gap-1">
							{list.map((e) => (
								<span key={`${e.type}-${e.id}`} className="small">
									{e.type === "proxy" ? (
										<>
											{e.ssl ? <IconLock size={12} className="text-green me-1" /> : null}
											{(e.domains || []).join(", ")}
										</>
									) : (
										<>
											<IconArrowsLeftRight size={12} className="text-blue me-1" />
											:{e.incomingPort} ({(e.protocols || []).join("/")})
										</>
									)}
								</span>
							))}
						</div>
					);
				},
			}),
			columnHelper.display({
				id: "id",
				cell: (info: any) => {
					const row: Stack = info.row.original;
					const busy = busyId === row.id;
					const act = (action: StackAction) => (e: any) => {
						e.preventDefault();
						onAction?.(row.id, action);
					};
					return (
						<span className="dropdown">
							<button
								type="button"
								className="btn dropdown-toggle btn-action btn-sm px-1"
								data-bs-boundary="viewport"
								data-bs-toggle="dropdown"
								disabled={busy}
							>
								<IconDotsVertical />
							</button>
							<div className="dropdown-menu dropdown-menu-end">
								<span className="dropdown-header">
									<T id="object.actions-title" tData={{ object: "stack" }} data={{ id: row.id }} />
								</span>
								<a className="dropdown-item" href="#" onClick={(e) => { e.preventDefault(); onEdit?.(row.id); }}>
									<IconEdit size={16} />
									<T id="action.edit" />
								</a>
								<a className="dropdown-item" href="#" onClick={(e) => { e.preventDefault(); onLogs?.(row.id); }}>
									<IconFileText size={16} />
									<T id="stack.action.logs" />
								</a>
								<HasPermission section={STACKS} permission={MANAGE} hideError>
									<a className="dropdown-item" href="#" onClick={(e) => { e.preventDefault(); onConsole?.(row.id); }}>
										<IconTerminal2 size={16} />
										<T id="stack.action.console" />
									</a>
									<a className="dropdown-item" href="#" onClick={(e) => { e.preventDefault(); onExpose?.(row.id); }}>
										<IconWorld size={16} />
										<T id="stack.action.expose" />
									</a>
									<a className="dropdown-item" href="#" onClick={(e) => { e.preventDefault(); onStream?.(row.id); }}>
										<IconArrowsLeftRight size={16} />
										<T id="stack.action.stream" />
									</a>
									<a className="dropdown-item" href="#" onClick={(e) => { e.preventDefault(); onEnv?.(row.id); }}>
										<IconVariable size={16} />
										<T id="stack.action.env" />
									</a>
									<a className="dropdown-item" href="#" onClick={(e) => { e.preventDefault(); onMounts?.(row.id); }}>
										<IconDatabase size={16} />
										<T id="stack.action.mounts" />
									</a>
									<a className="dropdown-item" href="#" onClick={(e) => { e.preventDefault(); onUpdates?.(row.id); }}>
										<IconRefresh size={16} />
										<T id="stack.action.check-updates" />
									</a>
									<a className="dropdown-item" href="#" onClick={(e) => { e.preventDefault(); onStatusSettings?.(row.id); }}>
										<IconActivity size={16} />
										<T id="stack.action.status-settings" />
									</a>
									<div className="dropdown-divider" />
									<a className="dropdown-item" href="#" onClick={act("deploy")}>
										<IconArrowUp size={16} />
										<T id="stack.action.deploy" />
									</a>
									<a className="dropdown-item" href="#" onClick={act("restart")}>
										<IconReload size={16} />
										<T id="stack.action.restart" />
									</a>
									<a className="dropdown-item" href="#" onClick={act("stop")}>
										<IconPlayerStop size={16} />
										<T id="stack.action.stop" />
									</a>
									<a className="dropdown-item" href="#" onClick={act("down")}>
										<IconPlayerStop size={16} />
										<T id="stack.action.down" />
									</a>
									<a className="dropdown-item" href="#" onClick={act("update")}>
										<IconRefresh size={16} />
										<T id="stack.action.update" />
									</a>
									<div className="dropdown-divider" />
									<a className="dropdown-item" href="#" onClick={(e) => { e.preventDefault(); onDelete?.(row.id); }}>
										<IconTrash size={16} />
										<T id="action.delete" />
									</a>
								</HasPermission>
							</div>
						</span>
					);
				},
				meta: { className: "text-end w-1" },
			}),
		],
		[columnHelper, busyId, onEdit, onAction, onDelete, onLogs, onConsole, onExpose, onMounts, onEnv, onStream, onUpdates, onStatusSettings],
	);

	const [sorting, setSorting] = useState<SortingState>([]);

	const tableInstance = useReactTable<Stack>({
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
					object="stack"
					objects="stacks"
					tableInstance={tableInstance}
					onNew={onNew}
					isFiltered={isFiltered}
					color="purple"
					permissionSection={STACKS}
				/>
			}
		/>
	);
}
