// Objection Docs:
// http://vincit.github.io/objection.js/

import { Model } from "objection";
import db from "../db.js";
import { convertBoolFieldsToInt, convertIntFieldsToBool } from "../lib/helpers.js";
import now from "./now_helper.js";
import User from "./user.js";

Model.knex(db());

const boolFields = ["is_deleted"];

class Stack extends Model {
	$beforeInsert() {
		this.created_on = now();
		this.modified_on = now();

		if (typeof this.meta === "undefined") {
			this.meta = {};
		}
	}

	$beforeUpdate() {
		this.modified_on = now();
	}

	$parseDatabaseJson(json) {
		const thisJson = super.$parseDatabaseJson(json);
		return convertIntFieldsToBool(thisJson, boolFields);
	}

	$formatDatabaseJson(json) {
		const thisJson = convertBoolFieldsToInt(json, boolFields);
		return super.$formatDatabaseJson(thisJson);
	}

	static get name() {
		return "Stack";
	}

	static get tableName() {
		return "stack";
	}

	static get jsonAttributes() {
		return ["meta"];
	}

	static get defaultAllowGraph() {
		return "[owner]";
	}

	static get defaultExpand() {
		return ["owner"];
	}

	static get defaultOrder() {
		return ["name", "ASC"];
	}

	static get relationMappings() {
		return {
			owner: {
				relation: Model.HasOneRelation,
				modelClass: User,
				join: {
					from: "stack.owner_user_id",
					to: "user.id",
				},
				modify: (qb) => {
					qb.where("user.is_deleted", 0);
				},
			},
		};
	}
}

export default Stack;
