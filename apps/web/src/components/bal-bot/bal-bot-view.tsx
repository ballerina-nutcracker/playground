import { BrowserWorkspace } from "@bal-bot/browser-workspace";
import { createCompiler } from "@bal-bot/compiler";
import { type ReactNode, useEffect, useRef, useState } from "react";

import "./bal-bot.css";
import { Editor } from "./editor";
import { streamBrowser } from "./providers";

type Files = Record<string, string>;

/**
 * The playground file system is the source of truth: nothing is restored from
 * storage, and every saved workspace snapshot is handed to `onChange` together
 * with the one before it, strictly in order.
 */
function forwardingStorage(
	files: Files,
	onChange: (prev: Files, next: Files) => Promise<void>,
) {
	let last = files;
	let queue = Promise.resolve();
	return {
		getItem: () => null,
		setItem: (_key: string, value: string) => {
			const prev = last;
			const next = JSON.parse(value) as Files;
			last = next;
			queue = queue.then(() => onChange(prev, next));
		},
	};
}

function projectNameOf(files: Record<string, string>): string {
	const match = /^\s*name\s*=\s*"([^"]+)"/m.exec(files["Ballerina.toml"] ?? "");
	return match?.[1] ?? "Project";
}

export function BalBotView({
	files,
	onChange,
	actions,
	footer,
}: {
	files: Files;
	/** Persists a workspace change; must not reject. */
	onChange: (prev: Files, next: Files) => Promise<void>;
	/** Buttons shown at the right of the toolbar. */
	actions: ReactNode;
	/** Shown below the workspace. */
	footer?: ReactNode;
}) {
	const [workspace, setWorkspace] = useState<BrowserWorkspace | null>(null);
	// A new callback must not recreate the workspace.
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	// The effect owns the workspace so StrictMode's mount/unmount/mount leaves
	// exactly one live instance.
	useEffect(() => {
		const storage = forwardingStorage(files, (prev, next) =>
			onChangeRef.current(prev, next),
		);
		const created = new BrowserWorkspace(storage, {
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
			<div className="flex h-10 flex-none items-center justify-between border-b">
				<span className="flex h-full max-w-[60%] items-center truncate border-r px-4 text-xs">
					{projectNameOf(files)}
				</span>
				<div className="flex h-full">{actions}</div>
			</div>
			<div className="min-h-0 flex-1">
				{workspace && <Editor workspace={workspace} />}
			</div>
			{footer}
		</div>
	);
}
