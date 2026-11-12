import { migrate as logger } from "../logger.js";

const migrateName = "stack_compose_hash";

/**
 * Migrate — remember the hash of the compose file as CompHost last wrote (or
 * adopted) it, so an edit made outside the UI can be told apart. Null means no
 * baseline yet: the first drift scan records one and reports nothing, so
 * upgrading doesn't flag every existing stack.
 *
 * @param   {Object} knex
 * @returns {Promise}
 */
const up = (knex) => {
	logger.info(`[${migrateName}] Migrating Up...`);
	return knex.schema
		.table("stack", (table) => {
			table.string("compose_hash", 64).nullable();
		})
		.then(() => {
			logger.info(`[${migrateName}] stack.compose_hash added`);
		});
};

/**
 * @param   {Object} knex
 * @returns {Promise}
 */
const down = (knex) => {
	logger.info(`[${migrateName}] Migrating Down...`);
	return knex.schema.table("stack", (table) => {
		table.dropColumn("compose_hash");
	});
};

export { down, up };
