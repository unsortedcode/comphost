import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A `<T id="…">` whose id isn't in the catalogue renders the raw id — "action.save"
 * shows up as button text instead of "Save". react-intl only complains on the
 * browser console, so this is invisible until someone happens to look at that
 * exact screen. Catch it here instead.
 */

const SRC = path.join(__dirname, "..");
const CATALOGUE = path.join(__dirname, "src", "en.json");

const walk = (dir: string, out: string[] = []): string[] => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules" && entry.name !== "lang") {
				walk(full, out);
			}
		} else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
			out.push(full);
		}
	}
	return out;
};

// <T id="x" /> and intl.formatMessage({ id: "x" }) with a literal id. Dynamic ids
// (template literals, variables) can't be checked statically and are skipped.
const ID_PATTERN = /(?:<T\s+id=|formatMessage\(\{\s*id:\s*)"([^"]+)"/g;

describe("locale catalogue", () => {
	const messages = JSON.parse(fs.readFileSync(CATALOGUE, "utf8")) as Record<string, unknown>;
	const files = walk(SRC);

	it("has every source file", () => {
		expect(files.length).toBeGreaterThan(50);
	});

	it("defines every message id referenced in the source", () => {
		const missing: string[] = [];
		for (const file of files) {
			const contents = fs.readFileSync(file, "utf8");
			for (const match of contents.matchAll(ID_PATTERN)) {
				if (!(match[1] in messages)) {
					missing.push(`${path.relative(SRC, file)} -> ${match[1]}`);
				}
			}
		}
		expect([...new Set(missing)]).toEqual([]);
	});
});
