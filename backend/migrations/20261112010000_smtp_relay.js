import { migrate as logger } from "../logger.js";

const migrateName = "smtp_relay";

/**
 * Migrate — the SMTP relay that hosted services reach as `smtp` on the comphost
 * network.
 *
 * smtp_upstream: the real mail servers mail is handed to. `security` is
 * none | starttls | tls; the password is masked on API read.
 *
 * smtp_route: which upstream takes a message, by sender. `match` is an exact
 * address, "@domain" or "*", unique, and the most specific match wins. With
 * `rewrite_from` set the sender is replaced by that address (the one the
 * upstream accepts) and the original goes into Reply-To and X-Original-From.
 *
 * @param   {Object} knex
 * @returns {Promise}
 */
const up = (knex) => {
	logger.info(`[${migrateName}] Migrating Up...`);
	return knex.schema
		.createTable("smtp_upstream", (table) => {
			table.increments().primary();
			table.dateTime("created_on").notNull();
			table.dateTime("modified_on").notNull();
			table.string("name").notNull();
			table.string("host").notNull();
			table.integer("port").notNull().unsigned();
			table.string("security").notNull().defaultTo("starttls");
			table.string("username").notNull().defaultTo("");
			table.string("password").notNull().defaultTo("");
		})
		.then(() =>
			knex.schema.createTable("smtp_route", (table) => {
				table.increments().primary();
				table.dateTime("created_on").notNull();
				table.dateTime("modified_on").notNull();
				table.string("match").notNull().unique();
				table.integer("upstream_id").notNull().unsigned();
				table.string("rewrite_from").notNull().defaultTo("");
				table.integer("keep_reply_to").notNull().unsigned().defaultTo(1);
			}),
		)
		.then(() => {
			logger.info(`[${migrateName}] smtp_upstream and smtp_route tables created`);
		});
};

/**
 * @param   {Object} knex
 * @returns {Promise}
 */
const down = (knex) => {
	logger.info(`[${migrateName}] Migrating Down...`);
	return knex.schema.dropTableIfExists("smtp_route").then(() => knex.schema.dropTableIfExists("smtp_upstream"));
};

export { down, up };
