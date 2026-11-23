import { defineConfig, devices } from "@playwright/test";

// Records PR demo videos. Paths are relative to this file; the repository root
// is four levels up. Demos and their output live in the git-ignored .pr-media/.
const ROOT = "../../../..";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: read by Playwright, not a Turbo task
const PORT = Number(process.env.PR_MEDIA_PORT ?? 4183);
const size = { width: 1280, height: 800 };

// Playwright's automatic failure snapshots are separate from screenshots and
// traces, and can include a password field's value.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

export default defineConfig({
	testDir: `${ROOT}/.pr-media/demos`,
	outputDir: `${ROOT}/.pr-media/videos`,
	timeout: 300_000,
	workers: 1,
	retries: 0,
	reporter: "list",
	use: {
		...devices["Desktop Chrome"],
		baseURL: `http://localhost:${PORT}`,
		viewport: size,
		video: { mode: "on", size },
		// Traces and screenshots capture typed values such as API keys.
		trace: "off",
		screenshot: "off",
		colorScheme: "light",
		// biome-ignore lint/suspicious/noUndeclaredEnvVars: read by Playwright, not a Turbo task
		launchOptions: { slowMo: Number(process.env.PR_MEDIA_SLOWMO ?? 150) },
	},
	webServer: {
		command: `bun --filter @playground/web build && bun --filter @playground/web preview --port ${PORT} --strictPort`,
		port: PORT,
		// Never reuse a server: one from another worktree would record the wrong build.
		reuseExistingServer: false,
		timeout: 600_000,
		cwd: ROOT,
	},
});
