import { expect, test } from "@playwright/test";

import { PlaygroundPage } from "../helpers/playground";

import type { Page } from "@playwright/test";

const balBotChunk = /bal-bot-view[^/]*\.js/;

async function openWithFailingChunk(page: Page) {
	await page.route(balBotChunk, (route) => route.abort());
	const playground = new PlaygroundPage(page);
	await playground.open();
	await playground.balBotButton.click();
	return playground;
}

// Reproducer for the PR #136 review comment on editor.tsx:916: a failed
// bal-bot-view chunk load must not replace the whole playground.
test("a failed bal-bot chunk load keeps the playground usable", async ({
	page,
}) => {
	const playground = await openWithFailingChunk(page);

	// The view closes and the editor is shown again; the router's error page
	// ("Something went wrong!") must not replace the app.
	await expect(page.getByText("Failed to load the agent view")).toBeVisible();
	await expect(page.getByTestId("code-editor")).toBeVisible();
	await expect(playground.runButton).toBeVisible();
	await expect(playground.balBotView).toHaveCount(0);
	await expect(page.getByText("Something went wrong!")).toHaveCount(0);
});

// Each import() of the chunk that fails dispatches Vite's vite:preloadError,
// so the count shows whether a later click imports again. React.lazy would
// re-throw its cached rejection instead, without a second import().
//
// The chunk stays blocked: Chromium keeps a failed module fetch in its module
// map, so importing the same URL again rejects without a new request even
// once the network is back.
test("opening bal-bot again after a failed chunk load retries the import", async ({
	page,
}) => {
	await page.addInitScript(() => {
		const w = window as unknown as { balBotLoadFailures: number };
		w.balBotLoadFailures = 0;
		window.addEventListener("vite:preloadError", () => {
			w.balBotLoadFailures++;
		});
	});
	const failures = () =>
		page.evaluate(
			() =>
				(window as unknown as { balBotLoadFailures: number })
					.balBotLoadFailures,
		);
	const playground = await openWithFailingChunk(page);
	const toast = page.getByText("Failed to load the agent view");
	await expect(toast).toBeVisible();
	await expect.poll(failures).toBe(1);
	await expect(page.getByTestId("code-editor")).toBeVisible();

	await playground.balBotButton.click();
	await expect.poll(failures).toBe(2);
	await expect(toast.first()).toBeVisible();
	await expect(page.getByTestId("code-editor")).toBeVisible();
	await expect(playground.runButton).toBeVisible();
	await expect(playground.balBotView).toHaveCount(0);
	await expect(page.getByText("Something went wrong!")).toHaveCount(0);
});
