import { expect, test } from "@playwright/test";

import { PlaygroundPage } from "../helpers/playground";

const WASM_ROUTE = "**/ballerina.wasm";

test("editor is usable while the wasm loads and Run is gated", async ({
	page,
}) => {
	let releaseWasm: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		releaseWasm = resolve;
	});
	await page.route(WASM_ROUTE, async (route) => {
		await gate;
		await route.continue();
	});

	await page.goto("/");
	const runButton = page.getByTestId("run-button");
	await expect(page.getByTestId("code-editor")).toBeVisible();
	await expect(runButton).toBeDisabled();
	await expect(page.getByTestId("run-loading")).toBeVisible();

	await page.keyboard.press("ControlOrMeta+Enter");
	await expect(page.getByTestId("output-pane")).toHaveText("");

	releaseWasm();
	await expect(runButton).toHaveText("Run", { timeout: 90_000 });
	await expect(runButton).toBeEnabled();
});

test("diagnostics appear once the wasm finishes loading", async ({ page }) => {
	let releaseWasm: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		releaseWasm = resolve;
	});
	await page.route(WASM_ROUTE, async (route) => {
		await gate;
		await route.continue();
	});

	const playground = new PlaygroundPage(page);
	await page.goto("/");
	await expect(page.getByTestId("code-editor")).toBeVisible();
	await playground.replaceEditorContent("public function main() { int x = ; }");
	await expect(page.locator(".cm-lintPoint")).toHaveCount(0);

	releaseWasm();
	await expect(page.locator(".cm-lintPoint").first()).toBeAttached({
		timeout: 90_000,
	});
});

test("a failed wasm load keeps Run disabled and shows an error", async ({
	page,
}) => {
	await page.route(WASM_ROUTE, (route) => route.abort());

	await page.goto("/");
	await expect(page.getByTestId("code-editor")).toBeVisible();
	await expect(page.getByText(/Failed to load Ballerina runtime/)).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByTestId("run-button")).toBeDisabled();
	await expect(page.getByTestId("run-button")).toContainText("Failed to load");
});
