import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

import type { Plugin } from "vite";

const metaPath = path.resolve(__dirname, "public/ballerina-meta.json");
const meta = fs.existsSync(metaPath)
	? JSON.parse(fs.readFileSync(metaPath, "utf-8"))
	: { version: "unknown" };

function githubPagesSpa(): Plugin {
	let outDir: string;
	return {
		name: "github-pages-spa",
		apply: "build",
		configResolved(config) {
			outDir = path.resolve(config.root, config.build.outDir);
		},
		async closeBundle() {
			const indexHtml = path.join(outDir, "index.html");
			await fs.promises.copyFile(indexHtml, path.join(outDir, "404.html"));
		},
	};
}

export default defineConfig(({ mode }) => {
	return {
		define: {
			__BALLERINA_VERSION__: JSON.stringify(meta.version),
			__COMMIT_SHA__: JSON.stringify(
				(mode === "production" && process.env.COMMIT_SHA) || "dev",
			),
		},
		plugins: [
			tanstackRouter({
				target: "react",
				autoCodeSplitting: true,
			}),
			tailwindcss(),
			react(),
			githubPagesSpa(),
		],
		worker: { format: "es" },
		resolve: {
			alias: {
				"@": path.resolve(__dirname, "./src"),
			},
		},
	};
});
