import comphostSettingModel from "../models/comphost_setting.js";

/**
 * Generic CompHost settings store (admin-only via the routes). Values are JSON.
 * Secret handling is the caller's concern (e.g. the Cloudflare module masks its
 * token on read); this layer just persists key -> value.
 */
const internalComphostSetting = {
	/**
	 * Get a raw setting value by key (returns null if unset). Not access-checked —
	 * internal callers use this; the route layer enforces admin.
	 * @param   {string} key
	 * @returns {Promise<any>}
	 */
	getRaw: async (key) => {
		const row = await comphostSettingModel.query().where("key", key).first();
		return row ? row.value : null;
	},

	/**
	 * Upsert a setting value.
	 * @param   {string} key
	 * @param   {any}    value
	 * @returns {Promise<any>}
	 */
	setRaw: async (key, value) => {
		const existing = await comphostSettingModel.query().where("key", key).first();
		if (existing) {
			await comphostSettingModel.query().where("key", key).patch({ value });
		} else {
			await comphostSettingModel.query().insert({ key, value });
		}
		return value;
	},
};

export default internalComphostSetting;
