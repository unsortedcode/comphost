import * as api from "./base";
import type { AuditLogExpansion } from "./expansions";
import type { AuditLog } from "./models";

/** Server-side filters for the audit log. Empty/undefined values are omitted. */
export interface AuditLogFilters {
	objectType?: string;
	action?: string;
	stack?: string;
	domain?: string;
}

/** Distinct values present in the log, for populating the filter controls. */
export interface AuditLogFilterOptions {
	objectTypes: string[];
	actions: string[];
	stacks: string[];
}

export async function getAuditLogs(
	expand?: AuditLogExpansion[],
	filters: AuditLogFilters = {},
	params = {},
): Promise<AuditLog[]> {
	return await api.get({
		url: "/audit-log",
		params: {
			expand: expand?.join(","),
			// The API decamelizes keys, so objectType arrives as object_type.
			...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
			...params,
		},
	});
}

export async function getAuditLogFilterOptions(): Promise<AuditLogFilterOptions> {
	return await api.get({ url: "/audit-log/filters" });
}
