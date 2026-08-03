import { migrate as logger } from "../logger.js";

const migrateName = "registry_credentials";

/**
 * Migrate — private container-registry logins. Stored so the backend can write
 * them into DOCKER_CONFIG (via `docker login`) and so `docker compose pull/up`
 * can fetch private images for stacks. The secret is masked on API read.
 *
 * @param   {Object} knex
 * @returns {Promise}
 */
const up = (knex) => {
	logger.info(`[${migrateName}] Migrating Up...`);
	return knex.schema
		.createTable("registry_credential", (table) => {
			table.increments().primary();
			table.dateTime("created_on").notNull();
			table.dateTime("modified_on").notNull();
			table.integer("owner_user_id").notNull().unsigned();
			table.integer("is_deleted").notNull().unsigned().defaultTo(0);
			table.string("name").notNull();
			// Registry host, e.g. "ghcr.io", "docker.io", "registry.example.com".
			table.string("registry").notNull();
			table.string("username").notNull();
			table.string("secret").notNull();
			table.json("meta").notNull();
		})
		.then(() => {
			logger.info(`[${migrateName}] registry_credential table created`);
		});
};

/**
 * @param   {Object} knex
 * @returns {Promise}
 */
const down = (knex) => {
	logger.info(`[${migrateName}] Migrating Down...`);
	return knex.schema.dropTableIfExists("registry_credential");
};

export { up, down };
