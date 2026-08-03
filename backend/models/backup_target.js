import { Model } from "objection";
import db from "../db.js";
import { convertBoolFieldsToInt, convertIntFieldsToBool } from "../lib/helpers.js";
import now from "./now_helper.js";
import User from "./user.js";

Model.knex(db());

const boolFields = ["is_deleted", "enabled"];

class BackupTarget extends Model {
	$beforeInsert() {
		this.created_on = now();
		this.modified_on = now();
		if (typeof this.meta === "undefined") this.meta = {};
		if (typeof this.config === "undefined") this.config = {};
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
		return "BackupTarget";
	}
	static get tableName() {
		return "backup_target";
	}
	static get jsonAttributes() {
		return ["config", "meta"];
	}
	static get relationMappings() {
		return {
			owner: {
				relation: Model.HasOneRelation,
				modelClass: User,
				join: { from: "backup_target.owner_user_id", to: "user.id" },
				modify: (qb) => qb.where("user.is_deleted", 0),
			},
		};
	}
}

export default BackupTarget;
