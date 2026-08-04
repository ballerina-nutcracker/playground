import { expect, test } from "@playwright/test";

import { loadFixture } from "../helpers/fixtures";
import { PlaygroundPage } from "../helpers/playground";

test("runs a listener and stops", async ({ page }) => {
	const playground = new PlaygroundPage(page);
	const listenerCode = await loadFixture("listener.bal");
	const packageName = `e2e_listener_${Date.now()}`;

	await playground.open();
	await playground.createPackage(packageName);
	await playground.replaceEditorContent(listenerCode);

	await expect(playground.runButton).toHaveText("Run");
	await playground.start();
	await expect(playground.runButton).toHaveText("Stop", { timeout: 10_000 });
	await expect(playground.outputPane).toHaveText("Listener started.", {
		timeout: 10_000,
	});

	await playground.stop();
	await expect(playground.outputPane).toContainText(
		"Graceful stop initiated.",
		{
			timeout: 10_000,
		},
	);
});
