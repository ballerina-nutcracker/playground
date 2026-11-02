import type React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { formatReference, type ChatDraft } from "./references";
import type { Id } from "@playground/workspace";
export interface ReferenceChipsProps {
	readonly draft: ChatDraft;
	readonly onRemove: (id: Id) => void;
}
export function ReferenceChips({
	draft,
	onRemove,
}: ReferenceChipsProps): React.JSX.Element {
	return (
		<div className="reference-chips">
			{draft.references.map((chip) => (
				<span
					key={chip.id}
					className={`reference-chip ${chip.stale ? "stale" : ""}`}
					title={
						chip.stale
							? "Source changed. Remove or reselect this reference."
							: chip.text
					}
				>
					{formatReference(chip.source)}
					{chip.stale && " · stale"}
					<button
						type="button"
						aria-label={`Remove ${formatReference(chip.source)}`}
						onClick={() => onRemove(chip.id)}
						className="inline-flex items-center"
					>
						<HugeiconsIcon
							icon={Cancel01Icon}
							strokeWidth={1.5}
							className="size-3"
							aria-hidden="true"
						/>
					</button>
				</span>
			))}
		</div>
	);
}
