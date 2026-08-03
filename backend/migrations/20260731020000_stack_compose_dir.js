import { migrate as logger } from "../logger.js";

const migrateName = "stack_compose_dir";

/**
 * Migrate — support adopting stacks that already exist on the host.
 *
 * CompHost normally keeps a stack at <stacksDir>/<name>/. An adopted stack lives
 * wherever its owner put it (e.g. /home/me/myapp), and MOVING it would break
 * relative bind mounts and orphan the running project. So we record the existing
 * directory instead and drive compose there in place. Empty = the default layout.
 *
 * @param   {Object} knex
 * @returns {Promise}
 */
const up = (knex) => {
	logger.info(`[${migrateName}] Migrating Up...`);
	return knex.schema
		.table("stack", (table) => {
			table.string("compose_dir").notNull().defaultTo("");
		})
		.then(() => {
			logger.info(`[${migrateName}] stack.compose_dir added`);
		});
};

/**
 * @param   {Object} knex
 * @returns {Promise}
 */
const down = (knex) => {
	logger.info(`[${migrateName}] Migrating Down...`);
	return knex.schema.table("stack", (table) => {
		table.dropColumn("compose_dir");
	});
};

export { up, down };
