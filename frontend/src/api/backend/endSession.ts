import * as api from "./base";

/**
 * End the browser session. Only the server can clear an HttpOnly cookie, so
 * logging out is a request rather than a localStorage delete. While
 * impersonating, this steps back to the original session — `restored` says
 * which happened.
 */
export async function endSession(): Promise<{ restored: boolean }> {
	return await api.del({ url: "/tokens" });
}
