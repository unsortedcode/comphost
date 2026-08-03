import { migrate as logger } from "../logger.js";

const migrateName = "comphost_settings";

/**
 * Migrate — a generic CompHost key/JSON settings store, separate from NPM's
 * `setting` table (which validates against a fixed set of ids). Holds CompHost
 * config like the Cloudflare API token and backup targets. Secret values are
 * masked on read by the internal layer.
 *
 * @param   {Object} knex
 * @returns {Promise}
 */
const up = (knex) => {
	logger.info(`[${migrateName}] Migrating Up...`);
	return knex.schema
		.createTable("comphost_setting", (table) => {
			table.increments().primary();
			table.dateTime("created_on").notNull();
			table.dateTime("modified_on").notNull();
			table.string("key").notNull().unique();
			table.json("value").notNull();
		})
		.then(() => {
			logger.info(`[${migrateName}] comphost_setting table created`);
		});
};

/**
 * @param   {Object} knex
 * @returns {Promise}
 */
const down = (knex) => {
	logger.info(`[${migrateName}] Migrating Down...`);
	return knex.schema.dropTableIfExists("comphost_setting");
};

export { up, down };
