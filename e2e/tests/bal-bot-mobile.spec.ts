import { expect, test } from "@playwright/test";

import { PlaygroundPage } from "../helpers/playground";

const WIDTH = 390;

test.use({ viewport: { width: WIDTH, height: 844 } });

test("agent view fits a 390px phone screen", async ({ page }) => {
	const playground = new PlaygroundPage(page);
	await playground.open();
	// The examples sidebar is a sheet on phones; use the default example.
	await expect(playground.balBotButton).toBeVisible();
	await playground.openBalBot();

	const view = playground.balBotView;
	const header = view.locator(".app > header");
	const main = view.locator(".flow-workspace > main");
	await expect(header.locator(".provider-trigger")).toBeVisible();

	const metrics = await view.evaluate((root) => {
		const r = (el: Element | null) => el?.getBoundingClientRect();
		const overflow = (selector: string) => {
			const el = root.querySelector(selector);
			if (!el) return [`${selector} missing`];
			const box = el.getBoundingClientRect();
			const found =
				el.scrollWidth > el.clientWidth
					? [`${selector}: scrollWidth ${el.scrollWidth} > ${el.clientWidth}`]
					: [];
			// A descendant that sticks out is clipped or pushes past the screen.
			for (const child of el.querySelectorAll("*")) {
				const c = child.getBoundingClientRect();
				if (c.width && (c.left < box.left - 1 || c.right > box.right + 1))
					found.push(`${selector} ${child.tagName}.${child.className}`);
			}
			return found;
		};
		const workspace = root.querySelector(".flow-workspace");
		return {
			viewport: window.innerWidth,
			root: r(root)?.width,
			provider: r(root.querySelector(".provider-trigger"))?.right,
			overflow: [
				...overflow(".app > header"),
				...overflow(".flow-workspace > main"),
			],
			panes: workspace
				? [...workspace.children].map((c) => c.getBoundingClientRect().width)
				: [],
		};
	});

	expect(metrics.root).toBeLessThanOrEqual(metrics.viewport);
	expect(metrics.provider).toBeLessThanOrEqual(metrics.viewport);
	expect(metrics.overflow).toEqual([]);
	// Stacked: the sidebar, chat and flow each use (nearly) the full width.
	expect(metrics.panes).toHaveLength(3);
	for (const width of metrics.panes) expect(width).toBeGreaterThan(WIDTH - 20);

	// The chat composer is reachable and usable.
	const composer = main.getByRole("textbox", { name: "Message" });
	await composer.scrollIntoViewIfNeeded();
	await expect(composer).toBeInViewport();
	await composer.fill("hello");
	await expect(
		main.getByRole("button", { name: "Send message" }),
	).toBeVisible();

	// The model list opens on top of the view and within the screen.
	const model = main.getByRole("combobox", { name: "Model" });
	await expect(model).toBeEnabled();
	await model.click();
	const listbox = page.getByRole("listbox");
	await expect(listbox).toBeVisible();
	const list = await listbox.boundingBox();
	expect(list && list.x >= 0 && list.x + list.width <= WIDTH).toBe(true);
	const options = page.getByRole("option");
	const last = options.last();
	const picked = (await last.innerText()).trim();
	const hit = await last.evaluate((option) => {
		const box = option.getBoundingClientRect();
		const top = document.elementFromPoint(
			box.left + box.width / 2,
			box.top + box.height / 2,
		);
		return !!top && option.contains(top);
	});
	expect(hit).toBe(true);
	await last.click();
	await expect(listbox).toBeHidden();
	await expect(model).toHaveText(picked);

	// The flow pane below the chat is reachable by scrolling the workspace.
	const inspection = view.getByRole("region", { name: "Flow inspection" });
	await inspection.scrollIntoViewIfNeeded();
	await expect(inspection).toBeInViewport();

	// The sidebar still collapses and expands.
	const collapse = view.getByRole("button", {
		name: "Collapse workspace sidebar",
	});
	await collapse.scrollIntoViewIfNeeded();
	await collapse.click();
	await expect(view.locator(".sidebar-content")).toBeHidden();
	await view.getByRole("button", { name: "Expand workspace sidebar" }).click();
	await expect(view.locator(".sidebar-content")).toBeVisible();

	// Expanding the flow keeps the chat floating within the screen.
	await view.getByRole("button", { name: "Expand inspection" }).click();
	await expect(main).toHaveClass(/floating-chat/);
	const chat = await main.boundingBox();
	expect(chat && chat.x >= 0 && chat.x + chat.width <= WIDTH).toBe(true);
	await view.getByRole("button", { name: "Collapse inspection" }).click();
	await expect(main).not.toHaveClass(/floating-chat/);
});
