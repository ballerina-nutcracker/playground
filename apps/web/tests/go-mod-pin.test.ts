import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function replaceBlock(goMod: string): string {
	const match = /^replace \(\n([\s\S]*?)^\)/m.exec(goMod);
	if (!match) throw new Error("go.mod has no replace block");
	return match[1];
}

function read(pkg: string): string {
	return readFileSync(
		resolve(import.meta.dir, "../../../packages", pkg, "go.mod"),
		"utf8",
	);
}

test("compiler and wasm go.mod replace blocks pin the same modules", () => {
	const wasm = replaceBlock(read("wasm"));
	expect(wasm.trim()).not.toBe("");
	expect(replaceBlock(read("compiler"))).toBe(wasm);
});
