import { readFile } from "node:fs/promises";
import { join } from "node:path";

export function loadFixture(name: string) {
	return readFile(join(process.cwd(), "e2e", "fixtures", name), "utf8");
}
