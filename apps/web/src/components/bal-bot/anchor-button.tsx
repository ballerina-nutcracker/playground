import type React from "react";
import { useEffect, useState } from "react";
import type { Anchor } from "@bal-bot/workspace";

type Activity = "idle" | "running" | "completed";

export function AnchorButton({
	anchor,
	className,
	onChoose,
	children,
	...props
}: {
	anchor: Anchor;
	className: string;
	onChoose(): void;
	children: React.ReactNode;
	"data-scope-id"?: string;
}): React.JSX.Element {
	const [activity, setActivity] = useState<Activity>("idle");
	useEffect(() => {
		let disposed = false;
		let unsubscribe: (() => void) | undefined;
		setActivity("idle");
		void anchor
			.getAgent()
			.then((agent) => {
				if (disposed) return;
				setActivity(agent.state.isStreaming ? "running" : "idle");
				unsubscribe = agent.subscribe((event) => {
					if (event.type === "agent_start") setActivity("running");
					if (event.type === "agent_end") {
						// The agent becomes idle after its end listeners finish.
						void agent.waitForIdle().then(() => {
							if (!disposed && !agent.state.isStreaming)
								setActivity("completed");
						});
					}
				});
			})
			.catch(() => {
				/* The chat reports agent initialization errors when opened. */
			});
		return () => {
			disposed = true;
			unsubscribe?.();
		};
	}, [anchor]);
	return (
		<button
			{...props}
			className={className}
			onClick={() => {
				setActivity((current) => (current === "completed" ? "idle" : current));
				onChoose();
			}}
		>
			{children}
			{activity !== "idle" && (
				<span
					className={`anchor-activity anchor-${activity}`}
					role="status"
					aria-label={
						activity === "running" ? "Chat running" : "Chat completed"
					}
					title={activity === "running" ? "Chat running" : "Chat completed"}
				/>
			)}
		</button>
	);
}
