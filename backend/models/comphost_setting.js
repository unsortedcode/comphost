// Objection model for the CompHost key/JSON settings store.
import { Model } from "objection";
import db from "../db.js";
import now from "./now_helper.js";

Model.knex(db());

class ComphostSetting extends Model {
	$beforeInsert() {
		this.created_on = now();
		this.modified_on = now();
		if (typeof this.value === "undefined") {
			this.value = {};
		}
	}

	$beforeUpdate() {
		this.modified_on = now();
	}

	static get name() {
		return "ComphostSetting";
	}

	static get tableName() {
		return "comphost_setting";
	}

	static get jsonAttributes() {
		return ["value"];
	}
}

export default ComphostSetting;
