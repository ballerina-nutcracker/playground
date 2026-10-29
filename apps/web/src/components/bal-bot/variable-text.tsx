import type React from "react";
import type { HIRVariableOccurrence } from "@bal-bot/workspace";

export interface VariableHover {
	readonly activeVariable?: string;
	readonly onVariableHover?: (id: string | undefined) => void;
}

/** Remap UTF-16 boundaries after visual wrapping, without searching token text.
 * A token split by wrapping remains one span, including the inserted newline. */
export function wrappedVariables(
	text: string,
	lines: readonly string[],
	variables: readonly HIRVariableOccurrence[] = [],
): readonly HIRVariableOccurrence[] {
	const starts: number[] = [],
		ends: number[] = [];
	let source = 0,
		display = 0;
	lines.forEach((line, index) => {
		for (let i = 0; i <= line.length; i++) {
			starts[source + i] = display + i;
			ends[source + i] ??= display + i;
		}
		source += line.length;
		display += line.length;
		if (index < lines.length - 1) {
			if (text[source] === "\n") source++;
			display++;
		}
	});
	return variables
		.filter((v) => v.start >= 0 && v.end > v.start && v.end <= text.length)
		.map((v) => ({ ...v, start: starts[v.start], end: ends[v.end] }));
}

/** Non-interactive spans deliberately preserve the parent node button's clicks. */
export function VariableText({
	text,
	variables = [],
	activeVariable,
	onVariableHover,
}: VariableHover & {
	readonly text: string;
	readonly variables?: readonly HIRVariableOccurrence[];
}): React.JSX.Element {
	const parts: React.ReactNode[] = [];
	let offset = 0;
	for (const [index, occurrence] of variables.entries()) {
		if (
			occurrence.start < offset ||
			occurrence.end <= occurrence.start ||
			occurrence.end > text.length
		)
			continue;
		parts.push(text.slice(offset, occurrence.start));
		parts.push(
			<span
				key={index}
				data-variable-id={occurrence.variableId}
				className={`variable-occurrence${activeVariable === occurrence.variableId ? " variable-active" : ""}`}
				onPointerEnter={(event) => {
					if (event.pointerType !== "touch")
						onVariableHover?.(occurrence.variableId);
				}}
				onPointerLeave={(event) => {
					if (event.pointerType !== "touch") onVariableHover?.(undefined);
				}}
			>
				{text.slice(occurrence.start, occurrence.end)}
			</span>,
		);
		offset = occurrence.end;
	}
	parts.push(text.slice(offset));
	return <>{parts}</>;
}
