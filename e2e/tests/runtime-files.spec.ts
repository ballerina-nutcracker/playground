import { expect, test } from "@playwright/test";

import { loadFixture } from "../helpers/fixtures";
import { PlaygroundPage } from "../helpers/playground";

test("shows files written by a running program in the sidebar", async ({
	page,
}) => {
	const playground = new PlaygroundPage(page);
	const writerCode = await loadFixture("write-file.bal");
	const packageName = `e2e_runtime_files_${Date.now()}`;

	await playground.open();
	await playground.createPackage(packageName);
	await playground.replaceEditorContent(writerCode);
	await playground.runAndExpectOutput("file written");

	await expect(page.getByText("generated", { exact: true })).toBeVisible();
	await expect(
		page.getByText("runtime-file.txt", { exact: true }),
	).toBeVisible();
});
