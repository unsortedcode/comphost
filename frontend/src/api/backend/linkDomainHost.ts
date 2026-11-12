import * as api from "./base";

/** Link a proxy/stream host to a stack service, or unlink it (stackId 0). */
export async function linkDomainHost(
	kind: "proxy" | "stream",
	hostId: number,
	stackId: number,
	service?: string,
): Promise<void> {
	await api.post({
		url: "/domains/link",
		data: { kind, hostId, stackId, ...(service ? { service } : {}) },
	});
}
