import { migrate as logger } from "../logger.js";

const migrateName = "mount_backups";

/**
 * Migrate — per-mount backup configuration.
 *
 * A stack's data lives in two shapes, which want different treatment:
 *   - named docker volumes  → snapshot with tar (streamed from a helper container)
 *   - bind mounts (host fs) → rsync is usually better: incremental, preserves the
 *     directory layout, cheap to repeat.
 * This table lets each volume/mount pick its own target and method, rather than
 * forcing one policy per stack.
 *
 * `source` is the volume name (kind=volume) or the host path (kind=bind).
 * A row is only needed to override defaults or to opt an item in/out.
 *
 * @param   {Object} knex
 * @returns {Promise}
 */
const up = (knex) => {
	logger.info(`[${migrateName}] Migrating Up...`);
	return knex.schema
		.createTable("mount_backup", (table) => {
			table.increments().primary();
			table.dateTime("created_on").notNull();
			table.dateTime("modified_on").notNull();
			table.integer("stack_id").notNull().unsigned();
			table.string("kind").notNull(); // volume | bind
			table.string("source").notNull(); // volume name, or host path
			table.integer("target_id").notNull().unsigned().defaultTo(0); // 0 = none/skip
			table.string("method").notNull().defaultTo("tar"); // tar | rsync
			table.integer("enabled").notNull().unsigned().defaultTo(1);
			table.json("meta").notNull();
			table.unique(["stack_id", "source"]);
		})
		.then(() => {
			logger.info(`[${migrateName}] mount_backup table created`);
		});
};

/**
 * @param   {Object} knex
 * @returns {Promise}
 */
const down = (knex) => {
	logger.info(`[${migrateName}] Migrating Down...`);
	return knex.schema.dropTableIfExists("mount_backup");
};

export { up, down };
