import { IconLock, IconLockOff } from "@tabler/icons-react";
import type { SslState } from "src/api/backend";
import { T } from "src/locale";

interface Props {
	state: SslState;
	/** ISO expiry; shown as days left when present */
	expiresOn?: string | null;
	/** Certificate name, shown on hover */
	title?: string;
}

const COLORS: Record<SslState, string> = {
	none: "bg-secondary-lt",
	valid: "bg-green-lt",
	expiring: "bg-orange-lt",
	expired: "bg-red-lt",
};

/** Same threshold as the backend (internal/domains.js). */
const EXPIRING_DAYS = 14;

/** State of a certificate from its expiry alone — for lists that only have the date. */
export const sslStateFromExpiry = (expiresOn?: string | null): SslState => {
	if (!expiresOn) return "valid";
	const days = (new Date(expiresOn).getTime() - Date.now()) / 86_400_000;
	return days < 0 ? "expired" : days < EXPIRING_DAYS ? "expiring" : "valid";
};

/** One SSL badge for every page that shows a host's certificate state. */
export function SslStateFormatter({ state, expiresOn, title }: Props) {
	const days = expiresOn ? Math.floor((new Date(expiresOn).getTime() - Date.now()) / 86_400_000) : null;
	return (
		<span className={`badge ${COLORS[state]}`} title={title}>
			{state === "none" ? <IconLockOff size={12} className="me-1" /> : <IconLock size={12} className="me-1" />}
			<T id={`ssl-state.${state}`} data={{ days: days ?? 0 }} />
		</span>
	);
}
