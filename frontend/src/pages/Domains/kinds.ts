import {
	type DomainKind,
	type DomainRow,
	deleteDeadHost,
	deleteProxyHost,
	deleteRedirectionHost,
	deleteStream,
	toggleDeadHost,
	toggleProxyHost,
	toggleRedirectionHost,
	toggleStream,
} from "src/api/backend";
import { showDeadHostModal, showProxyHostModal, showRedirectionHostModal, showStreamModal } from "src/modals";
import { DEAD_HOSTS, PROXY_HOSTS, REDIRECTION_HOSTS, type Section, STREAMS } from "src/modules/Permissions";

/** Everything the Domains page needs per host kind, so one row type drives all four. */
export const KIND: Record<
	DomainKind,
	{
		object: string;
		queryKeys: string[];
		edit: (id: number | "new") => void;
		toggle: (id: number, enabled: boolean) => Promise<boolean>;
		remove: (id: number) => Promise<boolean>;
	}
> = {
	proxy: {
		object: "proxy-host",
		queryKeys: ["proxy-hosts", "proxy-host"],
		edit: showProxyHostModal,
		toggle: toggleProxyHost,
		remove: deleteProxyHost,
	},
	redirect: {
		object: "redirection-host",
		queryKeys: ["redirection-hosts", "redirection-host"],
		edit: showRedirectionHostModal,
		toggle: toggleRedirectionHost,
		remove: deleteRedirectionHost,
	},
	dead: {
		object: "dead-host",
		queryKeys: ["dead-hosts", "dead-host"],
		edit: showDeadHostModal,
		toggle: toggleDeadHost,
		remove: deleteDeadHost,
	},
	stream: {
		object: "stream",
		queryKeys: ["streams", "stream"],
		edit: showStreamModal,
		toggle: toggleStream,
		remove: deleteStream,
	},
};

export const SECTION_OF: Record<DomainKind, Section> = {
	proxy: PROXY_HOSTS,
	redirect: REDIRECTION_HOSTS,
	dead: DEAD_HOSTS,
	stream: STREAMS,
};

/** Expired/expiring certificate, nginx rejected the config, drift, or an unlinked stack target. */
export const needsAttention = (row: DomainRow) =>
	row.enabled &&
	(row.sslState === "expired" ||
		row.sslState === "expiring" ||
		!row.online ||
		row.drift.some((d) => !d.repaired) ||
		!!row.linkSuggestion);
