import * as React from "react";

import { HugeiconsIcon } from "@hugeicons/react";
import {
	AiMagicIcon,
	ChevronDown,
	ChevronUp,
	CleanIcon,
	GithubFreeIcons,
	LayoutAlignRightIcon,
	LayoutRightIcon,
	PlayIcon,
	StopIcon,
} from "@hugeicons/core-free-icons";
import { useHotkeys } from "react-hotkeys-hook";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
	useSidebar,
} from "@/components/ui/sidebar";

import { AppSidebar } from "@/components/app-sidebar";
import { CodeEditor } from "@/components/code-editor";
import { TryItPanel } from "@/components/try-it-panel";
import { VersionCard } from "@/components/version-card";
import { SettingsDialog } from "@/components/settings-dialog";
import { ANSI } from "@/components/ansi";

import { basename, ext } from "@/lib/fs/core/path-utils";
import { startBalBotCheck } from "@/lib/bal-bot-availability";
import {
	getBallerinaProjectTarget,
	readBallerinaProjectFiles,
} from "@/lib/fs/project-target";
import { cn } from "@/lib/utils";

import { useIsDesktop } from "@/hooks/use-is-desktop";
import { useEditorStore } from "@/stores/editor-store";
import {
	useActiveFile,
	useFileTreeActions,
	useLocalTree,
	useTempTree,
} from "@/stores/file-tree-store";

import { useBallerina } from "@/providers/ballerina-provider";
import { useFS } from "@/providers/fs-provider";

import type { TryItPanelHandle } from "@/components/try-it-panel";
import type { EditorLanguage } from "@/components/code-editor";

// Dynamic import only from here: bal-bot, pi and the compiler load on first use.
const BalBotView = React.lazy(() =>
	import("@/components/bal-bot/bal-bot-view").then((m) => ({
		default: m.BalBotView,
	})),
);

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

function LoadingCircle({ progress }: { progress: number }) {
	const value = Math.max(0, Math.min(100, progress));
	const radius = 7;
	const circumference = 2 * Math.PI * radius;
	return (
		<svg
			role="progressbar"
			aria-label="Loading Ballerina runtime"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={value}
			data-testid="run-loading"
			viewBox="0 0 20 20"
			className="size-4 -rotate-90"
		>
			<circle
				cx="10"
				cy="10"
				r={radius}
				fill="none"
				stroke="currentColor"
				strokeOpacity={0.25}
				strokeWidth={2}
			/>
			<circle
				cx="10"
				cy="10"
				r={radius}
				fill="none"
				stroke="currentColor"
				strokeWidth={2}
				strokeDasharray={circumference}
				strokeDashoffset={circumference * (1 - value / 100)}
			/>
		</svg>
	);
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

function RightPane({ listenerAddresses }: { listenerAddresses: string[] }) {
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
				"flex flex-col min-h-0 min-w-0 overflow-hidden lg:h-full",
				outputOpen ? "flex-1 lg:flex" : "shrink-0 lg:flex",
			)}
		>
			<Tabs
				value={activeTab}
				onValueChange={(value) => setActiveTab(String(value))}
				className="min-h-0 flex-1 gap-0 overflow-hidden"
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
	onToggleOutput,
	outputCollapsed = false,
	onOpenBalBot,
	balBotDisabledReason,
}: {
	onRun: () => Promise<void>;
	isRunning: boolean;
	onStop: () => Promise<void>;
	onToggleOutput?: () => void;
	outputCollapsed?: boolean;
	onOpenBalBot: () => void;
	balBotDisabledReason: string | null;
}) {
	const activeFile = useActiveFile();
	const { isReady, progress, error } = useBallerina();

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
				"flex min-w-0 flex-col lg:border-b-0 lg:border-r min-h-0",
				"lg:h-full",
				outputOpen ? "h-1/2" : "flex-1",
			)}
		>
			<div className="flex h-10 shrink-0 items-center justify-between border-b">
				<span className="px-4 h-full text-xs border-r flex items-center truncate max-w-[60%]">
					{activeFile ? basename(activeFile.path) : "No file selected"}
				</span>
				<div className="flex h-full">
					<TooltipProvider>
						<Tooltip>
							<TooltipTrigger
								render={<span className="flex h-full border-r" />}
							>
								<Button
									className="h-full w-10"
									variant="ghost"
									data-testid="bal-bot-button"
									aria-label="Open in bal-bot"
									onClick={onOpenBalBot}
									disabled={balBotDisabledReason !== null}
								>
									<HugeiconsIcon icon={AiMagicIcon} strokeWidth={1.5} />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{balBotDisabledReason ?? "Open this project in bal-bot"}
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>
					<Button
						className="h-full"
						variant="ghost"
						data-testid="run-button"
						onClick={isRunning ? () => void onStop() : () => void onRun()}
						disabled={
							!isRunning &&
							(!isReady ||
								!activeFile ||
								getLanguage(activeFile.path) !== "ballerina")
						}
					>
						{!isRunning && error ? (
							<span className="min-w-7.5 text-destructive">Failed to load</span>
						) : !isRunning && !isReady ? (
							<>
								<LoadingCircle progress={progress} />
								<span className="min-w-7.5">Run</span>
							</>
						) : !isRunning ? (
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
					{onToggleOutput && (
						<Button
							className="h-full w-10 border-l"
							variant="ghost"
							onClick={onToggleOutput}
							aria-label={
								outputCollapsed ? "Show output pane" : "Hide output pane"
							}
						>
							<HugeiconsIcon
								icon={outputCollapsed ? LayoutRightIcon : LayoutAlignRightIcon}
								strokeWidth={1.5}
							/>
						</Button>
					)}
				</div>
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

function EditorWorkspace({
	onRun,
	isRunning,
	onStop,
	listenerAddresses,
	onOpenBalBot,
	balBotDisabledReason,
}: {
	onRun: () => Promise<void>;
	isRunning: boolean;
	onStop: () => Promise<void>;
	listenerAddresses: string[];
	onOpenBalBot: () => void;
	balBotDisabledReason: string | null;
}) {
	const isDesktop = useIsDesktop();
	const outputPanelRef = usePanelRef();
	const { defaultLayout, onLayoutChanged } = useDefaultLayout({
		id: "editor-workspace",
		storage: localStorage,
		onlySaveAfterUserInteractions: true,
	});
	const [outputCollapsed, setOutputCollapsed] = React.useState(false);
	const toggleOutputPanel = React.useCallback(() => {
		if (outputPanelRef.current?.isCollapsed()) outputPanelRef.current.expand();
		else outputPanelRef.current?.collapse();
	}, [outputPanelRef]);
	const editorPane = (
		<EditorPane
			onRun={onRun}
			isRunning={isRunning}
			onStop={onStop}
			onToggleOutput={isDesktop ? toggleOutputPanel : undefined}
			outputCollapsed={outputCollapsed}
			onOpenBalBot={onOpenBalBot}
			balBotDisabledReason={balBotDisabledReason}
		/>
	);
	const rightPane = <RightPane listenerAddresses={listenerAddresses} />;

	if (!isDesktop) {
		return (
			<div className="flex min-w-0 flex-1 flex-col min-h-0">
				{editorPane}
				{rightPane}
			</div>
		);
	}

	return (
		<ResizablePanelGroup
			orientation="horizontal"
			defaultLayout={defaultLayout}
			onLayoutChanged={onLayoutChanged}
		>
			<ResizablePanel
				id="editor"
				defaultSize="50%"
				minSize="30%"
				className="min-w-0"
			>
				{editorPane}
			</ResizablePanel>
			<ResizableHandle />
			<ResizablePanel
				id="output"
				panelRef={outputPanelRef}
				defaultSize="50%"
				collapsible
				collapsedSize="0%"
				minSize="20%"
				className="min-w-0 min-h-0 overflow-hidden"
				onResize={(size) => setOutputCollapsed(size.asPercentage === 0)}
			>
				{rightPane}
			</ResizablePanel>
		</ResizablePanelGroup>
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

	const { isReady, run, sendStopSignal } = useBallerina();

	const activeFile = useActiveFile();

	const { saveFile } = useFileTreeActions();
	const [isRunning, setIsRunning] = React.useState(false);
	const [listenerAddresses, setListenerAddresses] = React.useState<string[]>(
		[],
	);

	const openOutputWith = useEditorStore((s) => s.openOutputWith);
	const appendOutput = useEditorStore((s) => s.appendOutput);
	const toggleEditorMode = useEditorStore((s) => s.toggleEditorMode);

	// Snapshot of the project shown in the bal-bot view; null while closed.
	const [balBotFiles, setBalBotFiles] = React.useState<Record<
		string,
		string
	> | null>(null);
	const balBotOpen = balBotFiles !== null;
	const balBotOpening = React.useRef(false);

	// undefined while the latest check is pending. The trees are replaced on
	// every file-system sync, so creating or deleting Ballerina.toml re-runs it.
	const tempTree = useTempTree();
	const localTree = useLocalTree();
	const activePath = activeFile?.path ?? null;
	const [projectReason, setProjectReason] = React.useState<
		string | null | undefined
	>(undefined);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the trees only re-trigger the check
	React.useEffect(() => {
		setProjectReason(undefined);
		return startBalBotCheck(fs, activePath, setProjectReason);
	}, [fs, activePath, tempTree, localTree]);
	const balBotDisabledReason = isRunning
		? "Stop the running program first"
		: projectReason === undefined
			? "Checking project…"
			: projectReason;

	// Any change of the active file closes the view.
	const previousPath = React.useRef(activePath);
	React.useEffect(() => {
		if (previousPath.current === activePath) return;
		previousPath.current = activePath;
		setBalBotFiles(null);
	}, [activePath]);

	const closeBalBot = React.useCallback(() => setBalBotFiles(null), []);

	// The view needs the room: collapse the sidebar while it is open and restore it after.
	const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar();
	const sidebarBeforeBalBot = React.useRef<boolean | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: only the open/close transition matters
	React.useEffect(() => {
		if (balBotOpen) {
			sidebarBeforeBalBot.current = sidebarOpen;
			setSidebarOpen(false);
		} else if (sidebarBeforeBalBot.current !== null) {
			setSidebarOpen(sidebarBeforeBalBot.current);
			sidebarBeforeBalBot.current = null;
		}
	}, [balBotOpen]);

	const handleOpenBalBot = React.useCallback(async () => {
		if (!activeFile || balBotOpening.current) return;
		balBotOpening.current = true;
		try {
			// FIXME: We should automatically save files on change.
			await saveFile();
			const target = await getBallerinaProjectTarget(fs, activeFile.path);
			if (target === activeFile.path)
				throw new Error("Not part of a Ballerina project (no Ballerina.toml)");
			const files = await readBallerinaProjectFiles(fs, target);
			// The active file may have changed while reading; that must not open the view.
			if (previousPath.current !== activeFile.path) return;
			setBalBotFiles(files);
		} catch (cause) {
			toast.error(
				cause instanceof Error ? cause.message : "Failed to open bal-bot",
			);
		} finally {
			balBotOpening.current = false;
		}
	}, [activeFile, fs, saveFile]);

	const handleRun = React.useCallback(async () => {
		if (balBotOpen || balBotOpening.current) return;
		if (isRunning || !isReady) return;
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
		} catch (cause) {
			const message =
				cause instanceof Error
					? cause.message
					: "Failed to run Ballerina program";
			appendOutput(`\n${message}\n`);
			toast.error(message);
		} finally {
			isRunActive = false;
			setIsRunning(false);
			setListenerAddresses([]);
		}
	}, [
		activeFile,
		fs,
		saveFile,
		run,
		openOutputWith,
		appendOutput,
		isRunning,
		isReady,
		balBotOpen,
	]);

	const handleStop = React.useCallback(async () => {
		try {
			await sendStopSignal();
		} catch (cause) {
			toast.error(
				cause instanceof Error
					? cause.message
					: "Failed to stop Ballerina program",
			);
		}
	}, [sendStopSignal]);

	useHotkeys("mod+enter", () => void handleRun(), {
		preventDefault: true,
		enabled: !balBotOpen,
	});

	useHotkeys("mod+alt+v", () => toggleEditorMode(), {
		preventDefault: true,
		enabled: !balBotOpen,
	});

	return (
		<>
			<AppSidebar onFileSelect={closeBalBot} />
			<SidebarInset className="flex flex-col h-dvh overflow-hidden">
				<EditorHeader />
				<main className="flex flex-1 min-h-0">
					<div className="relative flex-1 min-h-0 min-w-0">
						{/* Hidden, never display:none, so the panel layout and the editor scroll survive. */}
						<div
							className={cn("absolute inset-0 flex", balBotOpen && "invisible")}
						>
							<EditorWorkspace
								onRun={handleRun}
								isRunning={isRunning}
								onStop={handleStop}
								listenerAddresses={listenerAddresses}
								onOpenBalBot={() => void handleOpenBalBot()}
								balBotDisabledReason={balBotDisabledReason}
							/>
						</div>
						{balBotFiles && (
							<div className="absolute inset-0 z-10 bg-background">
								<React.Suspense
									fallback={
										<div className="flex h-full items-center justify-center text-xs text-muted-foreground">
											Loading bal-bot…
										</div>
									}
								>
									<BalBotView files={balBotFiles} onBack={closeBalBot} />
								</React.Suspense>
							</div>
						)}
					</div>
				</main>
			</SidebarInset>
		</>
	);
}

export function Editor({
	defaultSidebarOpen = true,
}: {
	defaultSidebarOpen?: boolean;
}) {
	return (
		<SidebarProvider defaultOpen={defaultSidebarOpen}>
			<EditorContent />
		</SidebarProvider>
	);
}
