import * as React from "react";

import { HugeiconsIcon } from "@hugeicons/react";
import {
	ChevronDown,
	ChevronUp,
	CleanIcon,
	PlayIcon,
} from "@hugeicons/core-free-icons";
import { useHotkeys } from "react-hotkeys-hook";

import { Button } from "@/components/ui/button";
import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import { Progress } from "@/components/ui/progress";

import { AppSidebar } from "@/components/app-sidebar";
import { CodeEditor } from "@/components/code-editor";
import { SettingsDialog } from "@/components/settings-dialog";
import { ANSI } from "@/components/ansi";

import { basename, ext } from "@/lib/fs/core/path-utils";
import { getBallerinaProjectTarget } from "@/lib/fs/project-target";
import { cn } from "@/lib/utils";

import { useEditorStore } from "@/stores/editor-store";
import { useActiveFile, useFileTreeActions } from "@/stores/file-tree-store";

import { useBallerina } from "@/hooks/use-ballerina";
import { useFS } from "@/providers/fs-provider";

import type { EditorLanguage } from "@/components/code-editor";

function getLanguage(path: string): EditorLanguage {
	const ex = ext(path);
	switch (ex) {
		case "bal":
			return "ballerina";
		case "toml":
			return "toml";
		default:
			return "text";
	}
}

function findJsonFragmentEnd(text: string, start: number): number | null {
	const stack: string[] = [];
	let inString = false;
	let escaped = false;

	for (let index = start; index < text.length; index += 1) {
		const char = text[index];

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}

		if (char === "{" || char === "[") {
			stack.push(char === "{" ? "}" : "]");
			continue;
		}

		if (char === "}" || char === "]") {
			if (stack.pop() !== char) return null;
			if (stack.length === 0) return index + 1;
		}
	}

	return null;
}

function normalizeJsonValue(value: unknown): unknown {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				return normalizeJsonValue(JSON.parse(trimmed));
			} catch {
				return value;
			}
		}

		return value;
	}

	if (Array.isArray(value)) return value.map(normalizeJsonValue);

	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				normalizeJsonValue(entry),
			]),
		);
	}

	return value;
}

function stringifyPrettyJson(value: unknown): string {
	return JSON.stringify(normalizeJsonValue(value), null, 2);
}

function formatJsonOutput(output: string): string {
	const trimmed = output.trim();
	if (!trimmed) return output;

	try {
		const parsed: unknown = JSON.parse(trimmed);
		return stringifyPrettyJson(parsed);
	} catch {
		let formatted = "";
		let cursor = 0;

		while (cursor < output.length) {
			const char = output[cursor];

			if (char !== "{" && char !== "[") {
				formatted += char;
				cursor += 1;
				continue;
			}

			const end = findJsonFragmentEnd(output, cursor);
			if (end === null) {
				formatted += char;
				cursor += 1;
				continue;
			}

			const fragment = output.slice(cursor, end);
			try {
				const parsed: unknown = JSON.parse(fragment);
				formatted += stringifyPrettyJson(parsed);
				cursor = end;
			} catch {
				formatted += char;
				cursor += 1;
			}
		}

		return formatted;
	}
}

function OutputPane() {
	const output = useEditorStore((s) => s.output);
	const formattedOutput = React.useMemo(
		() => formatJsonOutput(output),
		[output],
	);
	const outputOpen = useEditorStore((s) => s.outputOpen);
	const toggleOutputOpen = useEditorStore((s) => s.toggleOutputOpen);
	const clearOutput = useEditorStore((s) => s.clearOutput);
	const scrollRef = React.useRef<HTMLDivElement>(null);
	const shouldAutoScrollRef = React.useRef(true);
	const previousOutputLengthRef = React.useRef(output.length);
	const previousOutputOpenRef = React.useRef(outputOpen);

	const updateAutoScrollState = React.useCallback(() => {
		const element = scrollRef.current;
		if (!element) return;

		const distanceFromBottom =
			element.scrollHeight - element.scrollTop - element.clientHeight;
		shouldAutoScrollRef.current = distanceFromBottom < 24;
	}, []);

	React.useLayoutEffect(() => {
		const element = scrollRef.current;
		if (!element) return;

		const outputWasReset = output.length < previousOutputLengthRef.current;
		const outputWasOpened = outputOpen && !previousOutputOpenRef.current;

		previousOutputLengthRef.current = output.length;
		previousOutputOpenRef.current = outputOpen;

		if (outputWasReset || outputWasOpened) {
			shouldAutoScrollRef.current = true;
		}

		if (shouldAutoScrollRef.current || outputOpen) {
			element.scrollTo({
				top: element.scrollHeight,
				behavior: outputWasReset ? "auto" : "smooth",
			});
		}
	}, [output, outputOpen]);

	return (
		<div
			className={cn(
				"flex flex-col min-h-0 min-w-0",
				"lg:w-1/2 lg:flex-none",
				outputOpen ? "flex-1 lg:flex" : "shrink-0 lg:flex",
			)}
		>
			<div className="flex h-10 shrink-0 items-center justify-between border-b border-t lg:border-t-0">
				<div className="flex items-center h-full">
					<span className="px-4 h-full text-xs text-muted-foreground flex items-center">
						Output
					</span>
				</div>
				<div className="flex items-center h-full">
					<Button
						className="h-full border-l lg:hidden"
						variant="ghost"
						onClick={toggleOutputOpen}
					>
						<HugeiconsIcon
							icon={outputOpen ? ChevronDown : ChevronUp}
							strokeWidth={1.5}
						/>
						<span className="text-xs">
							{outputOpen ? "Minimize" : "Show Output"}
						</span>
					</Button>
					<Button
						className="h-full border-l"
						variant="ghost"
						onClick={clearOutput}
					>
						<HugeiconsIcon icon={CleanIcon} strokeWidth={1.5} />
						<span className="hidden sm:inline">Clear</span>
					</Button>
				</div>
			</div>
			<div
				ref={scrollRef}
				data-testid="output-pane"
				onScroll={updateAutoScrollState}
				className={cn(
					"min-h-0 overflow-y-auto p-4",
					outputOpen ? "flex-1" : "hidden lg:block lg:flex-1",
				)}
			>
				<pre className="text-[13px] font-sans whitespace-pre-wrap wrap-break-word">
					<ANSI value={formattedOutput} />
				</pre>
			</div>
		</div>
	);
}

function EditorPane({
	onRun,
	isRunning,
}: {
	onRun: () => Promise<void>;
	isRunning: boolean;
}) {
	const activeFile = useActiveFile();

	const { updateFileContent } = useFileTreeActions();

	const outputOpen = useEditorStore((s) => s.outputOpen);
	const toggleEditorMode = useEditorStore((s) => s.toggleEditorMode);

	const handleChange = React.useCallback(
		(next: string) => {
			if (!activeFile) return;
			updateFileContent(next);
		},
		[activeFile, updateFileContent],
	);
	return (
		<div
			className={cn(
				"flex flex-col lg:border-b-0 lg:border-r min-h-0",
				"lg:w-1/2 lg:flex-none lg:h-full",
				outputOpen ? "h-1/2" : "flex-1",
			)}
		>
			<div className="flex h-10 shrink-0 items-center justify-between border-b">
				<span className="px-4 h-full text-xs border-r flex items-center truncate max-w-[60%]">
					{activeFile ? basename(activeFile.path) : "No file selected"}
				</span>
				<Button
					className="h-full rounded-none"
					variant="ghost"
					data-testid="run-button"
					onClick={() => void onRun()}
					disabled={
						isRunning ||
						!activeFile ||
						getLanguage(activeFile.path) !== "ballerina"
					}
				>
					{isRunning ? (
						<span>[...]</span>
					) : (
						<>
							<HugeiconsIcon icon={PlayIcon} strokeWidth={1.5} />
							<span>Run</span>
						</>
					)}
				</Button>
			</div>
			{activeFile && (
				<CodeEditor
					key={activeFile.path}
					filePath={activeFile.path}
					value={activeFile?.content}
					onChange={handleChange}
					hotkeys={{
						"Mod-Enter": () => void onRun(),
						"Mod-Alt-v": toggleEditorMode,
						"Mod-r": () => window.location.reload(),
					}}
					language={activeFile ? getLanguage(activeFile.path) : "text"}
				/>
			)}
		</div>
	);
}

function EditorHeader() {
	return (
		<header className="flex h-16 shrink-0 items-center justify-between border-b px-4">
			<div className="flex items-center gap-4">
				<SidebarTrigger className="-ml-1" />
				<h1 className="text-sm font-medium">Ballerina Playground</h1>
			</div>
			<div className="flex items-center gap-4">
				<a
					className="flex items-center gap-2 text-xs text-muted-foreground hover:text-secondary-foreground"
					href="https://github.com/orgs/ballerina-platform/projects/383"
					target="_blank"
					rel="noopener noreferrer"
				>
					<span>Roadmap</span>
				</a>
				<span className="text-xs text-muted-foreground select-none">
					{__BALLERINA_VERSION__}
				</span>
				<SettingsDialog />
			</div>
		</header>
	);
}

function EditorContent() {
	const fs = useFS();

	const { isReady, progress, run } = useBallerina();

	const activeFile = useActiveFile();

	const { saveFile } = useFileTreeActions();
	const [isRunning, setIsRunning] = React.useState(false);

	const openOutputWith = useEditorStore((s) => s.openOutputWith);
	const appendOutput = useEditorStore((s) => s.appendOutput);
	const toggleEditorMode = useEditorStore((s) => s.toggleEditorMode);

	const handleRun = React.useCallback(async () => {
		if (isRunning) return;
		if (!activeFile || getLanguage(activeFile.path) !== "ballerina") return;

		setIsRunning(true);
		try {
			// FIXME: We should automatically save files on change.
			await saveFile();

			const target = await getBallerinaProjectTarget(fs, activeFile.path);
			openOutputWith("");
			await run(target, ({ text }) => appendOutput(text));
		} finally {
			setIsRunning(false);
		}
	}, [activeFile, fs, saveFile, run, openOutputWith, appendOutput, isRunning]);

	useHotkeys("mod+enter", () => void handleRun(), {
		preventDefault: true,
	});

	useHotkeys("mod+alt+v", () => toggleEditorMode(), {
		preventDefault: true,
	});

	if (!isReady) return <WasmLoadingScreen progress={progress} />;

	return (
		<>
			<AppSidebar />
			<SidebarInset className="flex flex-col h-dvh overflow-hidden">
				<EditorHeader />
				<main className="flex flex-col lg:flex-row flex-1 min-h-0">
					<EditorPane onRun={handleRun} isRunning={isRunning} />
					<OutputPane />
				</main>
			</SidebarInset>
		</>
	);
}

function WasmLoadingScreen({ progress }: { progress: number }) {
	const pct = Math.max(0, Math.min(100, progress));
	return (
		<div
			className="w-full flex items-center justify-center min-h-dvh"
			data-testid="wasm-loading"
		>
			<div className="flex flex-col items-center gap-4">
				<div className="text-sm text-muted-foreground">
					Loading WASM binaries...&nbsp;
					<span className="inline-block text-right w-10 tabular-nums">
						{pct}%
					</span>
				</div>
				<Progress className="w-full" value={progress} />
			</div>
		</div>
	);
}

export function Editor() {
	return (
		<SidebarProvider>
			<EditorContent />
		</SidebarProvider>
	);
}
