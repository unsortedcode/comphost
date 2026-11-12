import * as api from "./base";

export type DomainKind = "proxy" | "redirect" | "dead" | "stream";
export type SslState = "none" | "valid" | "expiring" | "expired";

/** One served domain (or stream port) — see backend internal/domains.js. */
export interface DomainRow {
	domain: string;
	kind: DomainKind;
	hostId: number;
	enabled: boolean;
	/** false when nginx rejected this host's config, so it isn't being served */
	online: boolean;
	nginxErr: string | null;
	target: string;
	owner: { id: number; name: string } | null;
	certificate: { id: number; provider: string; niceName: string; expiresOn: string | null } | null;
	sslState: SslState;
	sslForced: boolean;
	stack: { id: number; name: string; service: string | null } | null;
	/** Set when the host points at a stack container but isn't linked to it */
	linkSuggestion: { stackId: number; stackName: string | null; service: string } | null;
	drift: { code: string; message: string; repaired?: boolean }[];
}

export async function getDomains(): Promise<DomainRow[]> {
	return await api.get({ url: "/domains" });
}
