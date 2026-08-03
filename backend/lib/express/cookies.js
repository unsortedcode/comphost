// Cookie-based sessions for the admin UI.
//
// The session JWT used to live in localStorage, which any XSS on the admin
// origin could read. On CompHost that credential also reaches the Docker
// socket, so it is worth putting out of JavaScript's reach entirely: the token
// now travels in an HttpOnly cookie.
//
// `Authorization: Bearer` still works and is unchanged — API clients and
// scripts depend on it, and a Bearer request cannot be forged cross-site
// because an attacker's page cannot set that header.
//
// Cookies can be sent cross-site, so cookie-authenticated writes are guarded by
// a double-submit CSRF token: a readable cookie whose value must be echoed in
// an X-CSRF-Token header. SameSite=Strict already blocks the common cases; this
// is the belt to that pair of braces.

import crypto from "node:crypto";
import errs from "../error.js";

export const SESSION_COOKIE = "comphost_session";
// Holds the admin's own token while they are impersonating someone, so
// "back to my account" doesn't need them to log in again.
export const ROOT_COOKIE = "comphost_session_root";
export const CSRF_COOKIE = "comphost_csrf";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Minimal cookie-header parser — avoids a dependency for one header.
 * @param   {Object} req
 * @returns {Object<string,string>}
 */
export const parseCookies = (req) => {
	const out = {};
	const header = req.headers?.cookie;
	if (!header) {
		return out;
	}
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) {
			continue;
		}
		const name = part.slice(0, eq).trim();
		if (name) {
			out[name] = decodeURIComponent(part.slice(eq + 1).trim());
		}
	}
	return out;
};

/**
 * Is this request on HTTPS? Honours the proxy header, since nginx terminates
 * TLS in front of us. Without this the Secure flag would never be set.
 * @param   {Object} req
 * @returns {boolean}
 */
const isSecure = (req) =>
	req.secure ||
	String(req.headers["x-forwarded-proto"] || "")
		.split(",")[0]
		.trim() === "https";

const serialise = (name, value, opts = {}) => {
	const bits = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Strict"];
	if (opts.httpOnly !== false) {
		bits.push("HttpOnly");
	}
	if (opts.secure) {
		bits.push("Secure");
	}
	if (typeof opts.maxAge === "number") {
		bits.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`);
	}
	return bits.join("; ");
};

const append = (res, cookie) => {
	const existing = res.getHeader("Set-Cookie");
	const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
	list.push(cookie);
	res.setHeader("Set-Cookie", list);
};

/** Seconds until an ISO expiry, floored at 0. */
const secondsUntil = (expires) => {
	const ms = new Date(expires).getTime() - Date.now();
	return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
};

/**
 * Put a freshly issued token in the session cookie, with a matching CSRF token.
 *
 * @param {Object}  req
 * @param {Object}  res
 * @param {Object}  tokenResponse       { token, expires }
 * @param {Object}  [opts]
 * @param {boolean} [opts.impersonating] preserve the current session as the root
 */
export const setSessionCookie = (req, res, tokenResponse, opts = {}) => {
	if (!tokenResponse?.token) {
		return;
	}
	const secure = isSecure(req);
	const maxAge = secondsUntil(tokenResponse.expires);

	if (opts.impersonating) {
		const current = parseCookies(req)[SESSION_COOKIE];
		if (current) {
			append(res, serialise(ROOT_COOKIE, current, { secure, maxAge }));
		}
	}

	append(res, serialise(SESSION_COOKIE, tokenResponse.token, { secure, maxAge }));
	// Readable by design: the SPA has to echo it back in a header.
	append(res, serialise(CSRF_COOKIE, crypto.randomBytes(32).toString("hex"), { secure, maxAge, httpOnly: false }));
};

/**
 * End the session, or step back out of an impersonated one.
 * @param   {Object} req
 * @param   {Object} res
 * @returns {{restored: boolean}} true when we popped back to the root session
 */
export const clearSessionCookie = (req, res) => {
	const secure = isSecure(req);
	const root = parseCookies(req)[ROOT_COOKIE];

	if (root) {
		// Was impersonating: restore the original session rather than logging out.
		append(res, serialise(SESSION_COOKIE, root, { secure }));
		append(res, serialise(ROOT_COOKIE, "", { secure, maxAge: 0 }));
		return { restored: true };
	}

	append(res, serialise(SESSION_COOKIE, "", { secure, maxAge: 0 }));
	append(res, serialise(ROOT_COOKIE, "", { secure, maxAge: 0 }));
	append(res, serialise(CSRF_COOKIE, "", { secure, maxAge: 0, httpOnly: false }));
	return { restored: false };
};

/**
 * Reject cookie-authenticated writes that don't echo the CSRF cookie.
 *
 * Only applies to cookie auth: Bearer requests can't be made cross-site with
 * the header attached, and unauthenticated requests have nothing to protect.
 */
export const csrfGuard = () => (req, res, next) => {
	if (SAFE_METHODS.has(req.method) || res.locals.authVia !== "cookie") {
		next();
		return;
	}
	const expected = parseCookies(req)[CSRF_COOKIE];
	const provided = req.headers["x-csrf-token"];
	if (!expected || !provided || expected !== provided) {
		next(new errs.PermissionError("CSRF token missing or invalid"));
		return;
	}
	next();
};

export default {
	SESSION_COOKIE,
	ROOT_COOKIE,
	CSRF_COOKIE,
	parseCookies,
	setSessionCookie,
	clearSessionCookie,
	csrfGuard,
};
