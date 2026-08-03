import { installPlugins } from "./lib/certbot.js";
import utils from "./lib/utils.js";
import internalNginx from "./internal/nginx.js";
import { setup as logger } from "./logger.js";
import authModel from "./models/auth.js";
import certificateModel from "./models/certificate.js";
import deadHostModel from "./models/dead_host.js";
import proxyHostModel from "./models/proxy_host.js";
import redirectionHostModel from "./models/redirection_host.js";
import settingModel from "./models/setting.js";
import streamModel from "./models/stream.js";
import userModel from "./models/user.js";
import userPermissionModel from "./models/user_permission.js";
import { existsSync } from "fs";
import fs from "fs/promises";

export const isSetup = async () => {
	const row = await userModel.query().select("id").where("is_deleted", 0).first();
	return row?.id > 0;
}

/**
 * Creates a default admin users if one doesn't already exist in the database
 *
 * @returns {Promise}
 */
const setupDefaultUser = async () => {
	const initialAdminEmail = process.env.INITIAL_ADMIN_EMAIL;
	const initialAdminPassword = process.env.INITIAL_ADMIN_PASSWORD;

	// This will only create a new user when there are no active users in the database
	// and the INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD environment variables are set.
	// Otherwise, users should be shown the setup wizard in the frontend.
	// I'm keeping this legacy behavior in case some people are automating deployments.

	if (!initialAdminEmail || !initialAdminPassword) {
		return Promise.resolve();
	}

	const userIsetup = await isSetup();
	if (!userIsetup) {
		// Create a new user and set password
		logger.info(`Creating a new user: ${initialAdminEmail} with password: ${initialAdminPassword}`);

		const data = {
			is_deleted: 0,
			email: initialAdminEmail,
			name: "Administrator",
			nickname: "Admin",
			avatar: "",
			roles: ["admin"],
		};

		const user = await userModel
			.query()
			.insertAndFetch(data);

		await authModel
			.query()
			.insert({
				user_id: user.id,
				type: "password",
				secret: initialAdminPassword,
				meta: {},
			});

		await userPermissionModel.query().insert({
			user_id: user.id,
			visibility: "all",
			proxy_hosts: "manage",
			redirection_hosts: "manage",
			dead_hosts: "manage",
			streams: "manage",
			access_lists: "manage",
			certificates: "manage",
		});
		logger.info("Initial admin setup completed");
	}
};

/**
 * Creates default settings if they don't already exist in the database
 *
 * @returns {Promise}
 */
const setupDefaultSettings = async () => {
	const row = await settingModel
		.query()
		.select("id")
		.where({ id: "default-site" })
		.first();

	if (!row?.id) {
		await settingModel
			.query()
			.insert({
				id: "default-site",
				name: "Default Site",
				description: "What to show when Nginx is hit with an unknown Host",
				value: "congratulations",
				meta: {},
			});
		logger.info("Default settings added");
	}
};

/**
 * Installs all Certbot plugins which are required for an installed certificate
 *
 * @returns {Promise}
 */
const setupCertbotPlugins = async () => {
	const certificates = await certificateModel
		.query()
		.where("is_deleted", 0)
		.andWhere("provider", "letsencrypt");

	if (certificates?.length) {
		const plugins = [];
		const promises = [];

		certificates.map((certificate) => {
			if (certificate.meta && certificate.meta.dns_challenge === true) {
				if (plugins.indexOf(certificate.meta.dns_provider) === -1) {
					plugins.push(certificate.meta.dns_provider);
				}

				// Make sure credentials file exists
				const credentials_loc = `/etc/letsencrypt/credentials/credentials-${certificate.id}`;
				if (typeof certificate.meta.dns_provider_credentials === "string") {
					promises.push(fs.mkdir("/etc/letsencrypt/credentials", { recursive: true })
								  .then(() => fs.writeFile(credentials_loc, certificate.meta.dns_provider_credentials, { mode: 0o600, flag: "wx" }))
								  .catch((err) => { if (err.code !== "EEXIST") throw err; }));
				}
			}
			return true;
		});
		
		await installPlugins(plugins);

		if (promises.length) {
			await Promise.all(promises);
			logger.info(`Added Certbot plugins ${plugins.join(", ")}`);
		}
	}
};

/**
 * Starts a timer to call run the logrotation binary every two days
 * @returns {Promise}
 */
const setupLogrotation = () => {
	const intervalTimeout = 1000 * 60 * 60 * 24 * 2; // 2 days

	const runLogrotate = async () => {
		try {
			await utils.exec("logrotate /etc/logrotate.d/nginx-proxy-manager");
			logger.info("Logrotate completed.");
		} catch (e) {
			logger.warn(e);
		}
	};

	logger.info("Logrotate Timer initialized");
	setInterval(runLogrotate, intervalTimeout);
	// And do this now as well
	return runLogrotate();
};

/**
 * Regenerate nginx configs for enabled hosts whose config file is missing.
 *
 * Host configs are written when a host is saved, not derived from the database at
 * boot — so a CompHost instance brought up against an existing database without
 * its /data/nginx directory (a database-only migration from a previous NPM box, a
 * restored backup, a wiped volume) shows every host in the UI while serving none
 * of them, with nothing to indicate why.
 *
 * Only missing files are written: an existing config is never overwritten, so
 * hand-edited or error-renamed configs are left alone.
 *
 * @returns {Promise}
 */
const setupMissingHostConfigs = async () => {
	const types = [
		{ type: "proxy_host", model: proxyHostModel, expand: ["certificate", "access_list.[clients,items]"] },
		{ type: "redirection_host", model: redirectionHostModel, expand: ["certificate"] },
		{ type: "dead_host", model: deadHostModel, expand: ["certificate"] },
		{ type: "stream", model: streamModel, expand: ["certificate"] },
	];

	let regenerated = 0;
	for (const { type, model, expand } of types) {
		try {
			const hosts = await model
				.query()
				.where("is_deleted", 0)
				.andWhere("enabled", 1)
				.withGraphFetched(`[${expand.join(", ")}]`);

			const missing = hosts.filter((host) => !existsSync(internalNginx.getConfigName(type, host.id)));
			if (!missing.length) {
				continue;
			}
			await internalNginx.bulkGenerateConfigs(type, missing);
			regenerated += missing.length;
			logger.info(`Regenerated ${missing.length} missing ${type} config(s)`);
		} catch (err) {
			// Never block boot over this — the UI still works, hosts just stay down.
			logger.warn(`Could not regenerate ${type} configs: ${err.message}`);
		}
	}

	if (regenerated) {
		try {
			await internalNginx.reload();
		} catch (err) {
			logger.warn(`Nginx reload after regenerating configs failed: ${err.message}`);
		}
	}
};

export default () =>
	setupDefaultUser()
		.then(setupDefaultSettings)
		.then(setupCertbotPlugins)
		.then(setupMissingHostConfigs)
		.then(setupLogrotation);
