import { test } from "@playwright/test";

import { loadFixture } from "../helpers/fixtures";
import { PlaygroundPage } from "../helpers/playground";

test("creates a package and runs hello world", async ({ page }) => {
	const playground = new PlaygroundPage(page);
	const helloWorldCode = await loadFixture("hello-world.bal");
	const packageName = `e2e_pkg_${Date.now()}`;

	await playground.open();
	await playground.createPackage(packageName);
	await playground.replaceEditorContent(helloWorldCode);
	await playground.runAndExpectOutput("Hello, World!");
});
