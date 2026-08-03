import { IconFilterOff } from "@tabler/icons-react";
import { useState } from "react";
import Alert from "react-bootstrap/Alert";
import type { AuditLogFilters } from "src/api/backend";
import { Button, LoadingPage } from "src/components";
import { useAuditLogFilterOptions, useAuditLogs } from "src/hooks";
import { intl, T } from "src/locale";
import { showEventDetailsModal } from "src/modals";
import Table from "./Table";

/** Turn "proxy-host" / "viewed-logs" into "Proxy host" / "Viewed logs". */
const humanize = (value: string) => {
	const spaced = value.replace(/[-_]/g, " ");
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

export default function TableWrapper() {
	const [filters, setFilters] = useState<AuditLogFilters>({});
	// The domain box commits on Enter/blur rather than per keystroke, so typing
	// a domain doesn't fire a request per character.
	const [domainInput, setDomainInput] = useState("");

	const { isFetching, isLoading, isError, error, data } = useAuditLogs(["user"], filters);
	const { data: options } = useAuditLogFilterOptions();

	if (isLoading) {
		return <LoadingPage />;
	}

	if (isError) {
		return <Alert variant="danger">{error?.message || "Unknown error"}</Alert>;
	}

	const set = (key: keyof AuditLogFilters, value: string) =>
		setFilters((f) => {
			const next = { ...f };
			if (value) {
				next[key] = value;
			} else {
				delete next[key];
			}
			return next;
		});

	const active = Object.keys(filters).length > 0;
	const clear = () => {
		setFilters({});
		setDomainInput("");
	};

	return (
		<div className="card mt-4">
			<div className="card-status-top bg-purple" />
			<div className="card-table">
				<div className="card-header">
					<div className="row w-full">
						<div className="col">
							<h2 className="mt-1 mb-0">
								<T id="auditlogs" />
							</h2>
						</div>
					</div>
				</div>

				<div className="card-body border-bottom py-2">
					<div className="d-flex flex-wrap gap-2 align-items-center">
						<select
							className="form-select form-select-sm w-auto"
							value={filters.objectType ?? ""}
							onChange={(e) => set("objectType", e.target.value)}
							aria-label={intl.formatMessage({ id: "auditlog.filter.object-type" })}
						>
							<option value="">{intl.formatMessage({ id: "auditlog.filter.all-objects" })}</option>
							{options?.objectTypes.map((t) => (
								<option key={t} value={t}>
									{humanize(t)}
								</option>
							))}
						</select>

						<select
							className="form-select form-select-sm w-auto"
							value={filters.action ?? ""}
							onChange={(e) => set("action", e.target.value)}
							aria-label={intl.formatMessage({ id: "auditlog.filter.action" })}
						>
							<option value="">{intl.formatMessage({ id: "auditlog.filter.all-actions" })}</option>
							{options?.actions.map((a) => (
								<option key={a} value={a}>
									{humanize(a)}
								</option>
							))}
						</select>

						<select
							className="form-select form-select-sm w-auto"
							value={filters.stack ?? ""}
							onChange={(e) => set("stack", e.target.value)}
							aria-label={intl.formatMessage({ id: "auditlog.filter.stack" })}
						>
							<option value="">{intl.formatMessage({ id: "auditlog.filter.all-stacks" })}</option>
							{options?.stacks.map((s) => (
								<option key={s} value={s}>
									{s}
								</option>
							))}
						</select>

						<input
							type="text"
							className="form-control form-control-sm w-auto"
							placeholder={intl.formatMessage({ id: "auditlog.filter.domain" })}
							value={domainInput}
							onChange={(e) => setDomainInput(e.target.value)}
							onBlur={() => set("domain", domainInput.trim())}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									set("domain", domainInput.trim());
								}
							}}
						/>

						{active ? (
							<Button size="sm" onClick={clear}>
								<IconFilterOff size={14} className="me-1" />
								<T id="auditlog.filter.clear" />
							</Button>
						) : null}
						{active && !isFetching ? (
							<span className="text-secondary small ms-auto">
								<T id="auditlog.filter.count" data={{ count: data?.length ?? 0 }} />
							</span>
						) : null}
					</div>
				</div>

				<Table data={data ?? []} isFetching={isFetching} onSelectItem={showEventDetailsModal} />
			</div>
		</div>
	);
}
