import { describe, expect, test } from "bun:test";

import { createFs } from "./test-fs";

import {
	getBalBotDisabledReason,
	startBalBotCheck,
} from "../src/lib/bal-bot-availability";

const withProject = () =>
	createFs(
		new Map([
			["/proj/Ballerina.toml", "[package]"],
			["/proj/main.bal", "main"],
			["/proj/README.md", "# readme"],
			["/loose/main.bal", "loose"],
		]),
	);

describe("getBalBotDisabledReason", () => {
	test("no active file", async () => {
		expect(await getBalBotDisabledReason(withProject(), null)).toBe(
			"No file open",
		);
	});

	test("loose file is disabled with a reason", async () => {
		expect(
			await getBalBotDisabledReason(withProject(), "/loose/main.bal"),
		).toBe("Not part of a Ballerina project (no Ballerina.toml)");
	});

	test("file in a project is enabled, including non-.bal files", async () => {
		const fs = withProject();
		expect(await getBalBotDisabledReason(fs, "/proj/main.bal")).toBeNull();
		expect(await getBalBotDisabledReason(fs, "/proj/README.md")).toBeNull();
		expect(
			await getBalBotDisabledReason(fs, "/proj/Ballerina.toml"),
		).toBeNull();
	});

	test("adding and removing Ballerina.toml changes the result", async () => {
		const fs = withProject();
		expect(await getBalBotDisabledReason(fs, "/loose/main.bal")).not.toBeNull();
		await fs.writeFile("/loose/Ballerina.toml", "[package]");
		expect(await getBalBotDisabledReason(fs, "/loose/main.bal")).toBeNull();
		await fs.remove("/loose/Ballerina.toml");
		expect(await getBalBotDisabledReason(fs, "/loose/main.bal")).not.toBeNull();
	});

	test("does not depend on any wasm readiness (only the fs is read)", async () => {
		expect(
			await getBalBotDisabledReason(withProject(), "/proj/main.bal"),
		).toBeNull();
	});
});

describe("startBalBotCheck", () => {
	test("a stale result for an earlier path is discarded", async () => {
		const fs = withProject();
		let releaseSlow: () => void = () => {};
		const slow = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const stat = fs.stat;
		fs.stat = async (path: string) => {
			if (path.startsWith("/loose")) await slow;
			return stat(path);
		};

		const results: (string | null)[] = [];
		const cancelFirst = startBalBotCheck(fs, "/loose/main.bal", (r) =>
			results.push(r),
		);
		cancelFirst();
		startBalBotCheck(fs, "/proj/main.bal", (r) => results.push(r));
		releaseSlow();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(results).toEqual([null]);
	});

	test("reports errors as the reason", async () => {
		const fs = withProject();
		fs.stat = async () => {
			throw new Error("disk gone");
		};
		const results: (string | null)[] = [];
		startBalBotCheck(fs, "/proj/main.bal", (r) => results.push(r));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(results).toEqual(["disk gone"]);
	});
});
