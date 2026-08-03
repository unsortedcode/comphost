import { useQuery } from "@tanstack/react-query";
import {
	type AuditLog,
	type AuditLogExpansion,
	type AuditLogFilterOptions,
	type AuditLogFilters,
	getAuditLogFilterOptions,
	getAuditLogs,
} from "src/api/backend";

const fetchAuditLogs = (expand?: AuditLogExpansion[], filters: AuditLogFilters = {}) => {
	return getAuditLogs(expand, filters);
};

const useAuditLogs = (expand?: AuditLogExpansion[], filters: AuditLogFilters = {}, options = {}) => {
	return useQuery<AuditLog[], Error>({
		queryKey: ["audit-logs", { expand, filters }],
		queryFn: () => fetchAuditLogs(expand, filters),
		staleTime: 10 * 1000,
		...options,
	});
};

/** Distinct object types, actions and stack names present in the log. */
const useAuditLogFilterOptions = (options = {}) => {
	return useQuery<AuditLogFilterOptions, Error>({
		queryKey: ["audit-log-filters"],
		queryFn: getAuditLogFilterOptions,
		staleTime: 60 * 1000,
		...options,
	});
};

export { fetchAuditLogs, useAuditLogFilterOptions, useAuditLogs };
