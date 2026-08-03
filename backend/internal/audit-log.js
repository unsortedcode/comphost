import { isPostgres } from "../lib/config.js";
import errs from "../lib/error.js";
import auditLogModel from "../models/audit-log.js";

/**
 * Substring match against the meta JSON.
 *
 * Filter values are user text — a stack named "legacy_ops" or a domain would
 * otherwise have its `_` and `%` read as LIKE wildcards. SQLite has no default
 * LIKE escape character (MySQL uses backslash), so declare one explicitly to get
 * the same behaviour on every engine we support.
 *
 * @param {Object} query  knex/objection query builder
 * @param {String} value  raw user input, matched as a substring
 */
const whereMetaContains = (query, value) => {
	const escaped = String(value).replace(/[!%_]/g, (ch) => `!${ch}`);
	const column = isPostgres() ? 'CAST("meta" AS text)' : "meta";
	query.whereRaw(`${column} LIKE ? ESCAPE '!'`, [`%${escaped}%`]);
};

const safeParse = (value) => {
	try {
		return JSON.parse(value);
	} catch (_err) {
		return null;
	}
};

const internalAuditLog = {

	/**
	 * All logs
	 *
	 * @param   {Access}  access
	 * @param   {Array}   [expand]
	 * @param   {String}  [searchQuery]
	 * @returns {Promise}
	 */
	getAll: async (access, expand, searchQuery, filters = {}) => {
		await access.can("auditlog:list");

		const query = auditLogModel
			.query()
			.orderBy("created_on", "DESC")
			.orderBy("id", "DESC")
			.limit(100)
			.allowGraph("[user]");

		// Query is used for searching
		if (typeof searchQuery === "string" && searchQuery.length > 0) {
			whereMetaContains(query, searchQuery);
		}

		// Event: the object acted on and/or what happened to it.
		if (filters.object_type) {
			query.where("object_type", filters.object_type);
		}
		if (filters.action) {
			query.where("action", filters.action);
		}
		// Stack: every stack entry records its name in meta.
		if (filters.stack) {
			query.where("object_type", "stack");
			whereMetaContains(query, `"name":"${filters.stack}"`);
		}
		// Domain: proxy/redirection/404 hosts record meta.domain_names.
		if (filters.domain) {
			whereMetaContains(query, filters.domain);
		}

		if (typeof expand !== "undefined" && expand !== null) {
			query.withGraphFetched(`[${expand.join(", ")}]`);
		}

		return await query;
	},

	/**
	 * Distinct values present in the log, for populating the filter controls —
	 * so the dropdowns only ever offer combinations that exist.
	 *
	 * @param   {Access}  access
	 * @returns {Promise<{objectTypes: string[], actions: string[], stacks: string[]}>}
	 */
	filterOptions: async (access) => {
		await access.can("auditlog:list");

		const [types, actions, stackRows] = await Promise.all([
			auditLogModel.query().distinct("object_type").orderBy("object_type"),
			auditLogModel.query().distinct("action").orderBy("action"),
			auditLogModel.query().select("meta").where("object_type", "stack").limit(1000),
		]);

		const stacks = new Set();
		for (const row of stackRows) {
			const meta = typeof row.meta === "string" ? safeParse(row.meta) : row.meta;
			if (meta?.name) {
				stacks.add(meta.name);
			}
		}

		return {
			objectTypes: types.map((r) => r.object_type).filter(Boolean),
			actions: actions.map((r) => r.action).filter(Boolean),
			stacks: [...stacks].sort((a, b) => a.localeCompare(b)),
		};
	},

	/**
	 * @param  {Access}   access
	 * @param  {Object}   [data]
	 * @param  {Integer}  [data.id]          Defaults to the token user
	 * @param  {Array}    [data.expand]
	 * @return {Promise}
	 */
	get: async (access, data) => {
		await access.can("auditlog:list");

		const query = auditLogModel
			.query()
			.andWhere("id", data.id)
			.allowGraph("[user]")
			.first();

		if (typeof data.expand !== "undefined" && data.expand !== null) {
			query.withGraphFetched(`[${data.expand.join(", ")}]`);
		}

		const row = await query;

		if (!row?.id) {
			throw new errs.ItemNotFoundError(data.id);
		}

		return row;
	},

	/**
	 * This method should not be publicly used, it doesn't check certain things. It will be assumed
	 * that permission to add to audit log is already considered, however the access token is used for
	 * default user id determination.
	 *
	 * @param   {Access}   access
	 * @param   {Object}   data
	 * @param   {String}   data.action
	 * @param   {Number}   [data.user_id]
	 * @param   {Number}   [data.object_id]
	 * @param   {Number}   [data.object_type]
	 * @param   {Object}   [data.meta]
	 * @returns {Promise}
	 */
	add: async (access, data) => {
		if (typeof data.user_id === "undefined" || !data.user_id) {
			data.user_id = access.token.getUserId(1);
		}

		if (typeof data.action === "undefined" || !data.action) {
			throw new errs.InternalValidationError("Audit log entry must contain an Action");
		}

		// Make sure at least 1 of the IDs are set and action
		return await auditLogModel.query().insert({
			user_id: data.user_id,
			action: data.action,
			object_type: data.object_type || "",
			object_id: data.object_id || 0,
			meta: data.meta || {},
		});
	},
};

export default internalAuditLog;
