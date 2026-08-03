import { parseCookies, SESSION_COOKIE } from "./cookies.js";

// Resolve the caller's token. Bearer wins so scripts and API clients keep
// working exactly as before; the cookie is what the browser UI uses, and it is
// tracked separately because only cookie auth needs CSRF protection.
export default function () {
	return (req, res, next) => {
		if (req.headers.authorization) {
			const parts = req.headers.authorization.split(" ");

			if (parts && parts[0] === "Bearer" && parts[1]) {
				res.locals.token = parts[1];
				res.locals.authVia = "bearer";
				next();
				return;
			}
		}

		const cookie = parseCookies(req)[SESSION_COOKIE];
		if (cookie) {
			res.locals.token = cookie;
			res.locals.authVia = "cookie";
		}

		next();
	};
}
