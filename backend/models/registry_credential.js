import { Model } from "objection";
import db from "../db.js";
import { convertBoolFieldsToInt, convertIntFieldsToBool } from "../lib/helpers.js";
import now from "./now_helper.js";

Model.knex(db());

const boolFields = ["is_deleted"];

class RegistryCredential extends Model {
	$beforeInsert() {
		this.created_on = now();
		this.modified_on = now();
		if (typeof this.meta === "undefined") this.meta = {};
	}

	$beforeUpdate() {
		this.modified_on = now();
	}

	$parseDatabaseJson(json) {
		return convertIntFieldsToBool(super.$parseDatabaseJson(json), boolFields);
	}

	$formatDatabaseJson(json) {
		return super.$formatDatabaseJson(convertBoolFieldsToInt(json, boolFields));
	}

	static get name() {
		return "RegistryCredential";
	}
	static get tableName() {
		return "registry_credential";
	}
	static get jsonAttributes() {
		return ["meta"];
	}
}

export default RegistryCredential;
