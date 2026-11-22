import { expect, test } from "@playwright/test";

import { loadFixture } from "../helpers/fixtures";
import { PlaygroundPage } from "../helpers/playground";

test("directory listener delivers changes, stops itself, and can run again", async ({
	page,
}) => {
	const playground = new PlaygroundPage(page);
	await playground.open();
	await playground.createPackage(`e2e_directory_listener_${Date.now()}`);
	await playground.replaceEditorContent(
		await loadFixture("directory-listener.bal"),
	);

	for (let attempt = 0; attempt < 2; attempt++) {
		await playground.start();
		await expect(playground.runButton).toHaveText("Stop", { timeout: 10_000 });
		await expect(playground.outputPane).toHaveText(
			"create:item.txt\nmodify:item.txt\ndelete:item.txt\ncreate:renamed.txt\nwatch stopped",
			{ timeout: 10_000 },
		);
		await playground.stop();
	}
});

test("directory listener receives file-tree mutations", async ({ page }) => {
	const playground = new PlaygroundPage(page);
	const packageName = `e2e_editor_listener_${Date.now()}`;
	const packagePath = `/local/${packageName}`;
	const watchedDir = `${packagePath}/somewhere`;
	const sourcePath = `${watchedDir}/hello.txt`;
	const renamedPath = `${watchedDir}/hello.md`;

	await playground.open();
	await playground.createPackage(packageName);
	await playground.createDirectory(packagePath, "somewhere");
	await playground.openFile(watchedDir);
	await playground.createFile(watchedDir, "hello.txt");
	await playground.openFile(`${packagePath}/main.bal`);
	await playground.replaceEditorContent(
		await loadFixture("directory-listener-editor.bal"),
	);

	await playground.start();
	await expect(playground.outputPane).toContainText("ready", {
		timeout: 10_000,
	});
	await playground.createFile(watchedDir, "live.txt");
	await expect(playground.outputPane).toContainText("create:live.txt", {
		timeout: 10_000,
	});

	await playground.openFile(sourcePath);
	await playground.replaceEditorContent("updated");
	await playground.openFile(`${packagePath}/main.bal`);
	await expect(playground.outputPane).toContainText("modify:hello.txt", {
		timeout: 10_000,
	});

	await playground.renameFile(sourcePath, "hello.md");
	await expect(playground.outputPane).toContainText("delete:hello.txt", {
		timeout: 10_000,
	});
	await expect(playground.outputPane).toContainText("create:hello.md", {
		timeout: 10_000,
	});

	await playground.deleteFile(renamedPath);
	await expect(playground.outputPane).toContainText("delete:hello.md", {
		timeout: 10_000,
	});
	await expect(playground.outputPane).not.toContainText(
		"Failed to sync file system mutation",
	);

	await playground.stop();
});

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
