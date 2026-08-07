import { expect, test } from "@playwright/test";

import { PlaygroundPage } from "../helpers/playground";

const SHARE_PAYLOAD =
	"H4sIAAAAAAAACnWQsWrDQBBEf%2BUylQ1CdtozaVKlNGl9Lk7SWl682j0uJ0MQ%2BvcgQZykSPuY2TfshGxW4CfcWDt4dJxRQeNA8OgzUWHtUaG9snSZFP70yF5Y6Cf8GkUos8a62CBLxbSQFnicUmxvsadzUMu9e3EBSeJnn23ULiDocmLFq3Ehd8ofbLrCff1c7wMwV%2F%2Boh8haN%2FGvlIdkubjme9aO7RA0aBob4dZdRm3LYljKm62bgjrnHJtPmbWIbgLeSMSeAraHoDPm81zBEuk7SSx8p2Ms119f2j1mzF%2FUrvUQVwEAAA%3D%3D";

test("opens a shared package and runs it", async ({ page }) => {
	const playground = new PlaygroundPage(page);
	await playground.open(`/?share=${SHARE_PAYLOAD}`);

	const sharedPackage = page
		.getByRole("button", { name: "greeting" })
		.locator("xpath=ancestor::li[1]");
	await expect(sharedPackage).toBeVisible({ timeout: 10_000 });
	await expect(
		sharedPackage.locator('[data-sidebar="menu-button"]'),
	).toHaveCount(3);
	await expect(
		sharedPackage.getByRole("button", { name: "Ballerina.toml" }),
	).toBeVisible();
	await expect(
		sharedPackage.getByRole("button", { name: "main.bal" }),
	).toBeVisible();

	await playground.runAndExpectOutput("Hello!");
});
