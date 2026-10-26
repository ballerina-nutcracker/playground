import { BrowserWorkspace } from "@bal-bot/browser-workspace";
import { createCompiler } from "@bal-bot/compiler";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

import "./bal-bot.css";
import { Editor } from "./editor";
import { streamBrowser } from "./providers";

// Workspace files live only in memory; never restore or persist browser source.
const noopStorage = { getItem: () => null, setItem: () => {} };

function projectNameOf(files: Record<string, string>): string {
	const match = /^\s*name\s*=\s*"([^"]+)"/m.exec(files["Ballerina.toml"] ?? "");
	return match?.[1] ?? "Project";
}

export function BalBotView({
	files,
	onBack,
}: {
	files: Record<string, string>;
	onBack: () => void;
}) {
	const [workspace, setWorkspace] = useState<BrowserWorkspace | null>(null);

	// The effect owns the workspace so StrictMode's mount/unmount/mount leaves
	// exactly one live instance.
	useEffect(() => {
		const created = new BrowserWorkspace(noopStorage, {
			streamFn: streamBrowser,
			compiler: createCompiler(),
			projectName: projectNameOf(files),
			files,
		});
		setWorkspace(created);
		return () => {
			created.dispose();
			setWorkspace(null);
		};
	}, [files]);

	return (
		<div className="bal-bot-root flex h-full min-h-0 flex-col bg-background text-foreground">
			<div className="flex-none border-b px-3 py-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={onBack}
					data-testid="bal-bot-back"
				>
					← Back
				</Button>
			</div>
			<div className="min-h-0 flex-1">
				{workspace && <Editor workspace={workspace} />}
			</div>
		</div>
	);
}
