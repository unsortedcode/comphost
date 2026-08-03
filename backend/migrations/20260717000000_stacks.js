import { migrate as logger } from "../logger.js";

const migrateName = "stacks";

/**
 * Migrate
 *
 * Adds the `stack` entity (a UI-managed docker-compose stack) and a `stacks`
 * column to `user_permission` so stacks participate in the existing RBAC model.
 *
 * The compose YAML itself lives on disk (COMPHOST_STACKS_DIR/<name>/) — the
 * filesystem is the source of truth, mirroring Dockge. This table is the managed
 * registry entry: ownership, permissions, and last-known status/metadata.
 *
 * @see http://knexjs.org/#Schema
 * @param   {Object} knex
 * @returns {Promise}
 */
const up = (knex) => {
	logger.info(`[${migrateName}] Migrating Up...`);

	return knex.schema
		.createTable("stack", (table) => {
			table.increments().primary();
			table.dateTime("created_on").notNull();
			table.dateTime("modified_on").notNull();
			table.integer("owner_user_id").notNull().unsigned();
			table.integer("is_deleted").notNull().unsigned().defaultTo(0);
			// Stack directory name; matches composeStackNameRegex (^[a-z0-9_-]+$).
			table.string("name").notNull();
			// Which compose file inside the dir (compose.yaml by default).
			table.string("compose_file_name").notNull().defaultTo("compose.yaml");
			// Last-known status code (see lib/compose/constants.js). Live status is
			// always re-derived from `docker compose`, this is a cache for listings.
			table.integer("status").notNull().unsigned().defaultTo(0);
			table.json("meta").notNull();
		})
		.then(() => {
			logger.info(`[${migrateName}] stack Table created`);

			return knex.schema.table("user_permission", (table) => {
				// Existing admins get manage; new users are set explicitly in code.
				table.string("stacks").notNull().defaultTo("manage");
			});
		})
		.then(() => {
			logger.info(`[${migrateName}] user_permission.stacks column added`);
		});
};

/**
 * Undo Migrate
 *
 * @param   {Object} knex
 * @returns {Promise}
 */
const down = (knex) => {
	logger.info(`[${migrateName}] Migrating Down...`);

	return knex.schema
		.dropTableIfExists("stack")
		.then(() => knex.schema.table("user_permission", (table) => table.dropColumn("stacks")))
		.then(() => {
			logger.info(`[${migrateName}] stack table dropped, permission column removed`);
		});
};

export { up, down };
