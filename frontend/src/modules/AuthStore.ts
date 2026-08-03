import { getUnixTime, parseISO } from "date-fns";
import type { TokenResponse } from "src/api/backend";

// Session metadata only — never the credential.
//
// The JWT lives in an HttpOnly cookie the browser attaches automatically, so
// script on this origin cannot read it. What is kept here is the expiry (so the
// UI knows when to refresh or bounce to the login page) and how deep the
// impersonation stack is (so "log out" knows whether it means "back to my
// account"). Neither is a secret.
export const SESSION_KEY = "session";
/** Pre-cookie key; cleared on load so stale tokens don't linger in storage. */
const LEGACY_TOKEN_KEY = "authentications";

interface SessionMeta {
	expires: string;
	/** 1 = normal session, 2 = impersonating someone. */
	depth: number;
}

export class AuthStore {
	constructor() {
		// One-time cleanup for anyone upgrading from the localStorage era.
		if (localStorage.getItem(LEGACY_TOKEN_KEY) !== null) {
			localStorage.removeItem(LEGACY_TOKEN_KEY);
		}
	}

	private get meta(): SessionMeta | null {
		const raw = localStorage.getItem(SESSION_KEY);
		if (raw === null) {
			return null;
		}
		try {
			return JSON.parse(raw) as SessionMeta;
		} catch {
			localStorage.removeItem(SESSION_KEY);
			return null;
		}
	}

	private write(meta: SessionMeta | null) {
		if (meta) {
			localStorage.setItem(SESSION_KEY, JSON.stringify(meta));
		} else {
			localStorage.removeItem(SESSION_KEY);
		}
	}

	get expires(): string | null {
		return this.meta?.expires ?? null;
	}

	/** True while the admin is impersonating another user. */
	get impersonating(): boolean {
		return (this.meta?.depth ?? 1) >= 2;
	}

	hasActiveToken(): boolean {
		const meta = this.meta;
		if (!meta) {
			return false;
		}
		const oneMinuteBuffer = 60;
		const now = Math.round(Date.now() / 1000);
		if (getUnixTime(parseISO(meta.expires)) - oneMinuteBuffer > now) {
			return true;
		}
		this.clear();
		return false;
	}

	/** Start (or refresh) a session. The token itself is ignored — it's in the cookie. */
	set({ expires }: TokenResponse) {
		// Declared as a number upstream, but the API sends an ISO timestamp.
		this.write({ expires: String(expires), depth: this.meta?.depth ?? 1 });
	}

	/** Impersonation began: the previous session is preserved server-side. */
	push({ expires }: TokenResponse) {
		this.write({ expires: String(expires), depth: (this.meta?.depth ?? 1) + 1 });
	}

	/** Impersonation ended; the server restored the original session cookie. */
	pop() {
		const meta = this.meta;
		if (!meta) {
			return;
		}
		this.write({ ...meta, depth: Math.max(1, meta.depth - 1) });
	}

	clear() {
		this.write(null);
	}
}

export default new AuthStore();
