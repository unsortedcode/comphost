import { migrate as logger } from "../logger.js";

const migrateName = "proxy_host_stack";

/**
 * Migrate — link a proxy host to the compose stack it exposes.
 *
 * `stack_id` = 0 means "not linked to a stack" (a normal proxy host). When set,
 * the proxy host was auto-created by CompHost's expose flow and targets a service
 * of that stack over the shared `comphost` docker network. `meta` carries the
 * exposed service name + container port so redeploys can re-attach the alias.
 *
 * @param   {Object} knex
 * @returns {Promise}
 */
const up = (knex) => {
	logger.info(`[${migrateName}] Migrating Up...`);

	return knex.schema
		.table("proxy_host", (table) => {
			table.integer("stack_id").notNull().unsigned().defaultTo(0);
		})
		.then(() => {
			logger.info(`[${migrateName}] proxy_host.stack_id column added`);
		});
};

/**
 * @param   {Object} knex
 * @returns {Promise}
 */
const down = (knex) => {
	logger.info(`[${migrateName}] Migrating Down...`);

	return knex.schema
		.table("proxy_host", (table) => {
			table.dropColumn("stack_id");
		})
		.then(() => {
			logger.info(`[${migrateName}] proxy_host.stack_id column dropped`);
		});
};

export { up, down };
