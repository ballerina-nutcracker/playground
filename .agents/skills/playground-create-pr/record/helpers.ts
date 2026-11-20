import { expect } from "@playwright/test";

import type { Page } from "@playwright/test";

export { PlaygroundPage } from "../../../../e2e/helpers/playground";

/** Gives a viewer time to read the screen before the next step. */
export function beat(page: Page, ms = 1_200) {
	return page.waitForTimeout(ms);
}

/**
 * Connects the agent view to OpenRouter with the key in OPENROUTER_API_KEY and
 * optionally selects a model by its display name. The key goes into a password
 * field, so it never appears on screen. Call after `openBalBot()`.
 */
export async function connectOpenRouter(page: Page, model?: string) {
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: read by Playwright, not a Turbo task
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error("OPENROUTER_API_KEY is not set");

	const view = page.locator(".bal-bot-root");
	await view.getByRole("button", { name: /^Provider:/ }).click();
	await page.getByRole("menuitemradio", { name: /^OpenRouter/ }).click();
	const dialog = page.getByRole("dialog", { name: "Provider API key" });
	const input = dialog.getByLabel("API key", { exact: true });
	await expect(input).toBeVisible();
	await expect(input).toHaveAttribute("type", "password");
	// `fill` puts its argument in Playwright's action log. Use the native
	// setter and input event so React sees the change without that log entry.
	await input.evaluate((element, value) => {
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		if (!(element instanceof HTMLInputElement) || !setValue) {
			throw new Error("API key field is not a native input");
		}
		setValue.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	}, key);
	await dialog.getByRole("button", { name: /API key$/ }).click();
	await expect(dialog).toBeHidden();

	if (model) {
		const picker = view.getByRole("combobox", { name: "Model" });
		// Switching provider reloads its model list and resets the selection;
		// retry until the chosen model sticks.
		await expect(async () => {
			if (await page.getByRole("listbox").isHidden()) await picker.click();
			await page.getByRole("option", { name: model, exact: true }).click();
			await expect(picker).toHaveText(model, { timeout: 1_000 });
		}).toPass({ timeout: 15_000 });
	}
}
