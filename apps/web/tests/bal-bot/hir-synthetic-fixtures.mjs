// Test-only fixture lookup. Never interpret archived legacy bodies at runtime.
import { readFileSync, readdirSync } from "node:fs";
const directory = new URL(
	"../../../../packages/compiler/testdata/upstream/tests/fixtures/hir-synthetic/",
	import.meta.url,
);
export function syntheticHIR(prefix) {
	const matches = readdirSync(directory).filter((name) =>
		name.startsWith(prefix),
	);
	if (matches.length !== 1)
		throw Error(
			`Expected one HIR fixture for ${prefix}, got ${matches.length}`,
		);
	return JSON.parse(
		readFileSync(new URL(`${matches[0]}/fixture.json`, directory), "utf8"),
	).hir;
}
