import { dirname } from "node:path";

import { expect } from "@playwright/test";

import type { Locator, Page } from "@playwright/test";

export type HttpRequest = {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	path: string;
	body?: string;
};

export class PlaygroundPage {
	readonly runButton: Locator;
	readonly outputPane: Locator;

	constructor(private readonly page: Page) {
		this.runButton = page.getByTestId("run-button");
		this.outputPane = page.getByTestId("output-pane");
	}

	async open(path = "/") {
		await this.page.goto(path);
		await expect(this.page.getByTestId("wasm-loading")).toBeHidden({
			timeout: 90_000,
		});
	}

	async run() {
		await expect(this.runButton).toBeEnabled({ timeout: 10_000 });
		await this.runButton.click();
		await expect(this.runButton).toHaveText("Run", { timeout: 10_000 });
	}

	async runAndExpectOutput(expectedOutput: string) {
		await this.run();
		await expect(this.outputPane).toHaveText(expectedOutput, {
			timeout: 10_000,
		});
	}

	async start() {
		await this.runButton.click();
	}

	async stop() {
		await this.runButton.click();
		await expect(this.runButton).toHaveText("Run", { timeout: 10_000 });
	}

	async createPackage(packageName: string) {
		await this.page.getByTestId("localspace-add").click();
		await this.page.getByRole("menuitem", { name: "New Package" }).click();

		const dialog = this.page.getByTestId("file-tree-dialog");
		await expect(dialog).toBeVisible();
		await dialog.getByLabel("Name").fill(packageName);
		await dialog.getByRole("button", { name: "Create" }).click();
		await expect(dialog).toBeHidden();
		await expect(this.page.getByText(packageName)).toBeVisible();
	}

	async replaceEditorContent(content: string) {
		const editor = this.page.getByTestId("code-editor").locator(".cm-content");
		await editor.click();
		await this.page.keyboard.press(
			process.platform === "darwin" ? "Meta+A" : "Control+A",
		);
		await this.page.keyboard.insertText(content);
	}

	async openExampleMain(manifestPath: string) {
		const mainPath = `${dirname(manifestPath)}/main.bal`;
		const mainFile = this.page.locator(
			`[data-example-path=${JSON.stringify(mainPath)}]`,
		);
		await expect(mainFile).toBeVisible();
		await mainFile.click();
	}

	async getExampleManifestPaths() {
		const examplesSidebar = this.page.getByTestId("examples-sidebar");
		await expect(
			examplesSidebar.locator("[data-example-path]"),
		).not.toHaveCount(0);

		const collapsedDirectories = examplesSidebar.locator(
			'[data-example-directory][data-expanded="false"]',
		);
		while ((await collapsedDirectories.count()) > 0) {
			const directory = collapsedDirectories.first();
			const directoryPath = await directory.getAttribute("data-example-path");
			if (!directoryPath) {
				throw new Error("Example directory is missing its path");
			}

			await directory.click();
			await expect(
				examplesSidebar.locator(
					`[data-example-directory][data-example-path=${JSON.stringify(directoryPath)}]`,
				),
			).toHaveAttribute("data-expanded", "true");
		}

		const manifestFiles = examplesSidebar.locator(
			'[data-example-path$="/Ballerina.toml"]',
		);
		await expect(manifestFiles).not.toHaveCount(0);
		return manifestFiles.evaluateAll((elements) =>
			elements
				.map((element) => element.getAttribute("data-example-path"))
				.filter((path): path is string => path !== null),
		);
	}

	async hasTryItPanel() {
		return this.page
			.getByRole("tab", { name: "Try It" })
			.waitFor({ state: "visible", timeout: 10_000 })
			.then(() => true)
			.catch(() => false);
	}

	async sendHttpRequest(request: HttpRequest) {
		await this.page.getByRole("tab", { name: "Try It" }).click();
		const tryItPanel = this.page.getByRole("tabpanel", { name: "Try It" });
		await this.page.getByLabel("HTTP method").click();
		await this.page.getByRole("option", { name: request.method }).click();
		await this.page.getByLabel("Request path").fill(request.path);
		if (request.body !== undefined) {
			await tryItPanel.getByRole("tab", { name: "Body" }).first().click();
			await tryItPanel
				.getByRole("textbox", { name: "Body" })
				.fill(request.body);
		}
		await tryItPanel.getByRole("button", { name: "Send" }).click();
		return tryItPanel;
	}
}
