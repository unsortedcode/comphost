import { migrate as logger } from "../logger.js";

const migrateName = "backup_targets";

/**
 * Migrate — backup destinations for stack volume backups.
 *
 * type: "s3" (via rclone) | "ssh" (via rsync-over-ssh). `config` holds the
 * connection details incl. secrets (masked on API read). `schedule_hours` > 0
 * means a timer backs up ALL stacks to this target on that cadence; on-demand
 * per-stack backups are always available.
 *
 * @param   {Object} knex
 * @returns {Promise}
 */
const up = (knex) => {
	logger.info(`[${migrateName}] Migrating Up...`);
	return knex.schema
		.createTable("backup_target", (table) => {
			table.increments().primary();
			table.dateTime("created_on").notNull();
			table.dateTime("modified_on").notNull();
			table.integer("owner_user_id").notNull().unsigned();
			table.integer("is_deleted").notNull().unsigned().defaultTo(0);
			table.string("name").notNull();
			table.string("type").notNull(); // s3 | ssh
			table.json("config").notNull();
			table.integer("enabled").notNull().unsigned().defaultTo(1);
			table.integer("schedule_hours").notNull().unsigned().defaultTo(0);
			table.dateTime("last_run").nullable();
			table.json("meta").notNull();
		})
		.then(() => {
			logger.info(`[${migrateName}] backup_target table created`);
		});
};

/**
 * @param   {Object} knex
 * @returns {Promise}
 */
const down = (knex) => {
	logger.info(`[${migrateName}] Migrating Down...`);
	return knex.schema.dropTableIfExists("backup_target");
};

export { up, down };
