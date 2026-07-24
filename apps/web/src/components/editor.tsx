import * as React from "react";

import { HugeiconsIcon } from "@hugeicons/react";
import {
	ChevronDown,
	ChevronUp,
	CleanIcon,
	GithubFreeIcons,
	PlayIcon,
	StopIcon,
} from "@hugeicons/core-free-icons";
import { useHotkeys } from "react-hotkeys-hook";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
} from "@/components/ui/sidebar";

import { AppSidebar } from "@/components/app-sidebar";
import { CodeEditor } from "@/components/code-editor";
import { TryItPanel } from "@/components/try-it-panel";
import { VersionCard } from "@/components/version-card";
import { SettingsDialog } from "@/components/settings-dialog";
import { ANSI } from "@/components/ansi";

import { basename, ext } from "@/lib/fs/core/path-utils";
import { getBallerinaProjectTarget } from "@/lib/fs/project-target";
import { cn } from "@/lib/utils";

import { useEditorStore } from "@/stores/editor-store";
import { useActiveFile, useFileTreeActions } from "@/stores/file-tree-store";

import { useBallerina } from "@/hooks/use-ballerina";
import { useFS } from "@/providers/fs-provider";

import type { TryItPanelHandle } from "@/components/try-it-panel";
import type { EditorLanguage } from "@/components/code-editor";
import type {
	HttpDispatchRequest,
	HttpDispatchResponse,
} from "@/workers/ballerina-worker-api";

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

function isStandaloneJsonFragment(
	text: string,
	start: number,
	end: number,
): boolean {
	const lineStart = text.lastIndexOf("\n", start - 1) + 1;
	const nextLineBreak = text.indexOf("\n", end);
	const lineEnd = nextLineBreak === -1 ? text.length : nextLineBreak;

	return (
		text.slice(lineStart, start).trim() === "" &&
		text.slice(end, lineEnd).trim() === ""
	);
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

			if (!isStandaloneJsonFragment(output, cursor, end)) {
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

function RightPane({
	listenerAddresses,
	dispatchHttpRequest,
}: {
	listenerAddresses: string[];
	dispatchHttpRequest: (
		request: HttpDispatchRequest,
	) => Promise<HttpDispatchResponse>;
}) {
	const output = useEditorStore((s) => s.output);
	const formattedOutput = React.useMemo(
		() => formatJsonOutput(output),
		[output],
	);
	const outputOpen = useEditorStore((s) => s.outputOpen);
	const toggleOutputOpen = useEditorStore((s) => s.toggleOutputOpen);
	const clearOutput = useEditorStore((s) => s.clearOutput);

	const scrollRef = React.useRef<HTMLDivElement>(null);
	const tryItPanelRef = React.useRef<TryItPanelHandle>(null);
	const shouldAutoScrollRef = React.useRef(true);
	const previousOutputLengthRef = React.useRef(output.length);
	const previousOutputOpenRef = React.useRef(outputOpen);

	const showTryIt = listenerAddresses.length > 0;
	const previousShowTryItRef = React.useRef(showTryIt);

	const [activeTab, setActiveTab] = React.useState("output");

	React.useEffect(() => {
		const didOpenTryIt = showTryIt && !previousShowTryItRef.current;
		previousShowTryItRef.current = showTryIt;

		if (didOpenTryIt) {
			setActiveTab("try-it");
			return;
		}

		if (!showTryIt) setActiveTab("output");
	}, [showTryIt]);

	const handleClear = React.useCallback(() => {
		if (activeTab === "try-it") {
			tryItPanelRef.current?.clear();
			return;
		}

		clearOutput();
	}, [activeTab, clearOutput]);

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
			<Tabs
				value={activeTab}
				onValueChange={(value) => setActiveTab(String(value))}
				className="min-h-0 flex-1 gap-0"
			>
				<div className="flex h-10 shrink-0 items-center justify-between border-b border-t lg:border-t-0">
					<TabsList className="h-full! p-0">
						<TabsTrigger
							value="output"
							className="h-full px-4 bg-background border-0 border-r border-border"
						>
							Output
						</TabsTrigger>
						{showTryIt && (
							<TabsTrigger
								value="try-it"
								className="h-full px-4 bg-background border-0 border-r border-border"
							>
								Try It
							</TabsTrigger>
						)}
					</TabsList>
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
								{outputOpen ? "Minimize" : "Show Pane"}
							</span>
						</Button>
						<Button
							className="h-full border-l"
							variant="ghost"
							onClick={handleClear}
						>
							<HugeiconsIcon icon={CleanIcon} strokeWidth={1.5} />
							<span className="hidden sm:inline">Clear</span>
						</Button>
					</div>
				</div>
				<TabsContent
					value="output"
					keepMounted
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
				</TabsContent>
				{showTryIt && (
					<TabsContent
						value="try-it"
						keepMounted
						className={cn(
							"min-h-0 overflow-y-auto p-4",
							outputOpen ? "flex-1" : "hidden lg:block lg:flex-1",
						)}
					>
						<TryItPanel
							ref={tryItPanelRef}
							listenerAddresses={listenerAddresses}
							dispatchHttpRequest={dispatchHttpRequest}
						/>
					</TabsContent>
				)}
			</Tabs>
		</div>
	);
}

function EditorPane({
	onRun,
	isRunning,
	onStop,
}: {
	onRun: () => Promise<void>;
	isRunning: boolean;
	onStop: () => Promise<void>;
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
					className="h-full"
					variant="ghost"
					data-testid="run-button"
					onClick={isRunning ? () => void onStop() : () => void onRun()}
					disabled={
						!isRunning &&
						(!activeFile || getLanguage(activeFile.path) !== "ballerina")
					}
				>
					{!isRunning ? (
						<>
							<HugeiconsIcon icon={PlayIcon} strokeWidth={1.5} />
							<span className="min-w-7.5">Run</span>
						</>
					) : (
						<>
							<HugeiconsIcon icon={StopIcon} strokeWidth={1.5} />
							<span className="min-w-7.5">Stop</span>
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
				<VersionCard />
				<a
					className="flex items-center gap-2 text-xs text-muted-foreground hover:text-secondary-foreground"
					href="https://github.com/ballerina-nutcracker/playground"
					target="_blank"
					rel="noopener noreferrer"
				>
					<HugeiconsIcon icon={GithubFreeIcons} strokeWidth={1.5} size={16} />
					<span className="sm:block hidden">GitHub</span>
				</a>
				<SettingsDialog />
			</div>
		</header>
	);
}

function EditorContent() {
	const fs = useFS();

	const { isReady, progress, run, sendStopSignal, dispatchHttpRequest } =
		useBallerina();

	const activeFile = useActiveFile();

	const { saveFile } = useFileTreeActions();
	const [isRunning, setIsRunning] = React.useState(false);
	const [listenerAddresses, setListenerAddresses] = React.useState<string[]>(
		[],
	);

	const openOutputWith = useEditorStore((s) => s.openOutputWith);
	const appendOutput = useEditorStore((s) => s.appendOutput);
	const toggleEditorMode = useEditorStore((s) => s.toggleEditorMode);

	const handleRun = React.useCallback(async () => {
		if (isRunning) return;
		if (!activeFile || getLanguage(activeFile.path) !== "ballerina") return;

		let isRunActive = true;
		setIsRunning(true);
		setListenerAddresses([]);
		try {
			// FIXME: We should automatically save files on change.
			await saveFile();

			const target = await getBallerinaProjectTarget(fs, activeFile.path);
			openOutputWith("");
			await run(target, (event) => {
				if (event.type === "output") appendOutput(event.text);
				if (event.type === "listeners" && isRunActive)
					setListenerAddresses(event.hosts);
			});
		} finally {
			isRunActive = false;
			setIsRunning(false);
			setListenerAddresses([]);
		}
	}, [activeFile, fs, saveFile, run, openOutputWith, appendOutput, isRunning]);

	const handleStop = React.useCallback(async () => {
		await sendStopSignal();
	}, [sendStopSignal]);

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
					<EditorPane
						onRun={handleRun}
						isRunning={isRunning}
						onStop={handleStop}
					/>
					<RightPane
						listenerAddresses={listenerAddresses}
						dispatchHttpRequest={dispatchHttpRequest}
					/>
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
