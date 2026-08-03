import { migrate as logger } from "../logger.js";

const migrateName = "backup_cron";

/**
 * Migrate — cron scheduling for backup targets.
 *
 * `schedule_hours` (a crude "every N hours") stays for backwards compatibility,
 * but a cron expression is what people actually want: "0 3 * * *" (nightly at 3am)
 * rather than "every 24 hours from whenever it last ran". When schedule_cron is
 * set it takes precedence.
 *
 * @param   {Object} knex
 * @returns {Promise}
 */
const up = (knex) => {
	logger.info(`[${migrateName}] Migrating Up...`);
	return knex.schema
		.table("backup_target", (table) => {
			table.string("schedule_cron").notNull().defaultTo("");
		})
		.then(() => {
			logger.info(`[${migrateName}] backup_target.schedule_cron added`);
		});
};

/**
 * @param   {Object} knex
 * @returns {Promise}
 */
const down = (knex) => {
	logger.info(`[${migrateName}] Migrating Down...`);
	return knex.schema.table("backup_target", (table) => {
		table.dropColumn("schedule_cron");
	});
};

export { up, down };
