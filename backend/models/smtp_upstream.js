import { Model } from "objection";
import db from "../db.js";
import now from "./now_helper.js";

Model.knex(db());

class SmtpUpstream extends Model {
	$beforeInsert() {
		this.created_on = now();
		this.modified_on = now();
	}

	$beforeUpdate() {
		this.modified_on = now();
	}

	static get name() {
		return "SmtpUpstream";
	}
	static get tableName() {
		return "smtp_upstream";
	}
}

export default SmtpUpstream;
