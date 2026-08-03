import { Model } from "objection";
import db from "../db.js";
import { convertBoolFieldsToInt, convertIntFieldsToBool } from "../lib/helpers.js";
import now from "./now_helper.js";

Model.knex(db());

const boolFields = ["enabled"];

class MountBackup extends Model {
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
		return "MountBackup";
	}
	static get tableName() {
		return "mount_backup";
	}
	static get jsonAttributes() {
		return ["meta"];
	}
}

export default MountBackup;
