import { migrate as logger } from "../logger.js";

const migrateName = "stream_stack";

/**
 * Migrate — link a stream host to the stack it exposes, mirroring
 * proxy_host.stack_id. Needed so exposing a stack over TCP/UDP can be listed
 * alongside its HTTP exposures and cleaned up when the stack is deleted.
 *
 * @param   {Object} knex
 * @returns {Promise}
 */
const up = (knex) => {
	logger.info(`[${migrateName}] Migrating Up...`);
	return knex.schema
		.table("stream", (table) => {
			table.integer("stack_id").notNull().unsigned().defaultTo(0);
		})
		.then(() => {
			logger.info(`[${migrateName}] stream.stack_id added`);
		});
};

/**
 * @param   {Object} knex
 * @returns {Promise}
 */
const down = (knex) => {
	logger.info(`[${migrateName}] Migrating Down...`);
	return knex.schema.table("stream", (table) => {
		table.dropColumn("stack_id");
	});
};

export { up, down };
