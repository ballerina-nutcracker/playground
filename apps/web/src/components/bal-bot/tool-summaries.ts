import type { AgentMessage } from "@bal-bot/workspace";

export type ToolSummaryState = "running" | "completed" | "failed" | "stopped";
export interface ToolSummary {
	kind: "tool";
	id: string;
	state: ToolSummaryState;
	text: string;
}
export type ConversationItem =
	| { kind: "message"; message: AgentMessage }
	| ToolSummary;
type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;

const actions: Record<string, readonly [string, string, string]> = {
	list_files: ["Listing files", "Listed files", "list files"],
	read_file: ["Reading file", "Read file", "read file"],
	write_file: ["Writing file", "Wrote file", "write file"],
	edit_file: ["Editing file", "Edited file", "edit file"],
	delete_file: ["Deleting file", "Deleted file", "delete file"],
	get_diagnostics: ["Checking source", "Checked source", "check source"],
};

function resultText(result: ToolResult): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

// Never copy arbitrary error text: it can contain paths, source, or a stack trace.
function failureReason(result: ToolResult): string {
	const text = resultText(result).replace(/^Error:\s*/, "");
	if (text.startsWith("File not found:")) return "File not found.";
	if (text === "oldText must match exactly once. Read the file and try again.")
		return "Text to replace must match exactly once.";
	if (
		text.startsWith("Could not save browser files.") ||
		text.startsWith("Could not restore or initialize browser files.") ||
		text === "Browser storage is read-only."
	)
		return "Browser storage is unavailable.";
	if (text === "A file conflicts with this directory path.")
		return "File and directory paths conflict.";
	if (text === "Only .md, .bal and .toml files are supported.")
		return "Unsupported file type.";
	if (text === "File contents must be valid UTF-8 text.")
		return "Invalid text encoding.";
	if (
		text ===
		"Use a relative workspace file path without empty, . or .. segments."
	)
		return "Invalid workspace path.";
	if (text === "A compiler is required to request workspace diagnostics.")
		return "Compiler unavailable.";
	if (text.startsWith("Invalid arguments for tool "))
		return "Invalid tool arguments.";
	if (
		text ===
		"Unknown built-in skill. Choose a name from the available skills catalog."
	)
		return "Unknown built-in skill.";
	return "Operation could not be completed.";
}

function skillName(value: unknown): string | undefined {
	return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
		? value
		: undefined;
}

function namedField(value: unknown, key: string): unknown {
	return value !== null &&
		typeof value === "object" &&
		Object.hasOwn(value, key)
		? (value as Record<string, unknown>)[key]
		: undefined;
}

export function summarizeTool(
	name: string,
	state: ToolSummaryState,
	result?: ToolResult,
	nameContext?: unknown,
): string {
	const selectedSkill =
		name === "read_skill"
			? skillName(
					state === "completed"
						? namedField(result?.details, "skillName")
						: nameContext,
				)
			: undefined;
	const skill = selectedSkill ? `skill ${selectedSkill}` : "skill";
	const [running, completed, action] =
		name === "read_skill"
			? [`Using ${skill}`, `Using ${skill}`, `use ${skill}`]
			: Object.hasOwn(actions, name)
				? actions[name]
				: ["Working", "Finished action", "complete action"];
	switch (state) {
		case "running":
			return `${running}…`;
		case "completed":
			return completed;
		case "stopped":
			return `Stopped: ${action}`;
		case "failed":
			return `Could not ${action}. ${result ? failureReason(result) : "Operation could not be completed."}`;
	}
}

export function conversationItems(
	messages: readonly AgentMessage[],
	running: boolean,
): ConversationItem[] {
	const results = new Map<string, ToolResult>();
	const calls = new Set<string>();
	let lastUser = -1;
	messages.forEach((message, index) => {
		if (message.role === "user") lastUser = index;
		if (message.role === "toolResult") results.set(message.toolCallId, message);
		if (message.role === "assistant")
			for (const part of message.content)
				if (part.type === "toolCall") calls.add(part.id);
	});
	const items: ConversationItem[] = [];
	const seen = new Set<string>();
	const addTool = (
		id: string,
		name: string,
		pending: ToolSummaryState,
		nameContext?: unknown,
	) => {
		if (seen.has(id)) return;
		seen.add(id);
		const result = results.get(id);
		const state = !result
			? pending
			: !result.isError
				? "completed"
				: /^(?:Error:\s*)?(?:Operation aborted|Request aborted by user|This operation was aborted)\.?$/.test(
							resultText(result),
						)
					? "stopped"
					: "failed";
		items.push({
			kind: "tool",
			id,
			state,
			text: summarizeTool(name, state, result, nameContext),
		});
	};
	messages.forEach((message, index) => {
		if (message.role === "system") return;
		if (message.role === "toolResult") {
			if (!calls.has(message.toolCallId))
				addTool(message.toolCallId, message.toolName, "stopped");
		} else if (message.role === "assistant") {
			let text = "";
			const flush = (error = false) => {
				if (text || (error && message.errorMessage))
					items.push({
						kind: "message",
						message: {
							...message,
							content: text ? [{ type: "text", text }] : [],
							errorMessage: error ? message.errorMessage : undefined,
						},
					});
				text = "";
			};
			for (const part of message.content) {
				if (part.type === "text") text += (text ? "\n" : "") + part.text;
				if (part.type === "toolCall") {
					flush();
					addTool(
						part.id,
						part.name,
						message.stopReason === "error"
							? "failed"
							: message.stopReason === "aborted" || index < lastUser || !running
								? "stopped"
								: "running",
						namedField(part.arguments, "name"),
					);
				}
			}
			flush(true);
		} else items.push({ kind: "message", message });
	});
	return items;
}
