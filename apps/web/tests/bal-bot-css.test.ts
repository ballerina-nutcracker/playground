import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "../src/components/bal-bot");
const ROOT = ".bal-bot-root";

function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// Returns the selector lists of every style rule, descending into @media.
function selectorLists(css: string): string[] {
	const lists: string[] = [];
	let i = 0;
	while (i < css.length) {
		const open = css.indexOf("{", i);
		if (open === -1) break;
		const head = css.slice(i, open).trim();
		let depth = 1;
		let j = open + 1;
		while (depth) {
			if (css[j] === "{") depth++;
			else if (css[j] === "}") depth--;
			j++;
		}
		const body = css.slice(open + 1, j - 1);
		if (head.startsWith("@media") || head.startsWith("@supports")) {
			lists.push(...selectorLists(body));
		} else if (!head.startsWith("@")) {
			lists.push(head);
		}
		i = j;
	}
	return lists;
}

const sheets = readdirSync(dir).filter((f) => f.endsWith(".css"));

test("bal-bot has stylesheets", () => {
	expect(sheets).toContain("bal-bot.css");
	expect(sheets).toContain("function-cards.css");
});

for (const sheet of sheets) {
	test(`${sheet}: every selector is scoped under ${ROOT}`, () => {
		const css = stripComments(readFileSync(join(dir, sheet), "utf8"));
		expect(css).not.toContain("@import");
		for (const list of selectorLists(css)) {
			for (const selector of list.split(",").map((s) => s.trim())) {
				expect(selector.startsWith(ROOT)).toBe(true);
				expect(selector).not.toMatch(
					/^\.bal-bot-root\s+(\*|:root|body|html)\b/,
				);
			}
		}
	});
}
