import errs from "../error.js";

export default (req, res, next) => {
	if (req.params.user_id === "me") {
		// Anonymous callers used to crash here dereferencing a null token, which
		// surfaced as a 500. Sessions can now end server-side (cookie cleared or
		// expired), so this needs to be a clean 401 for the UI to act on.
		const id = res.locals.access?.token?.get?.("attrs")?.id;
		if (!id) {
			next(new errs.AuthenticationRequiredError());
			return;
		}
		req.params.user_id = id;
	} else {
		req.params.user_id = Number.parseInt(req.params.user_id, 10);
	}
	next();
};
