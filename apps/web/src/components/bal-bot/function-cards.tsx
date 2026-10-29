import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { HIRGraph, Id } from "@bal-bot/workspace";
import type { FunctionInteraction } from "./flow-svg";
import "./function-cards.css";

interface Card {
	id: Id;
	x: number;
	y: number;
	open: boolean;
}
const WIDTH = 440;
const GAP = 24;
/** Function identity, not invocation identity, owns each view and its position. */
export function FunctionCards({
	entryId,
	graphs,
	render,
}: {
	entryId: Id;
	graphs: Readonly<Record<Id, HIRGraph>>;
	render: (id: Id, interaction: FunctionInteraction) => React.ReactNode;
}): React.JSX.Element {
	const [cards, setCards] = useState<Card[]>([]);
	const [hovered, highlight] = useState<Id | null>(null);
	const [active, activate] = useState<Id | null>(null);
	const highlighted = hovered ?? active;
	const entry = useRef<HTMLDivElement>(null);
	const elements = useRef(new Map<Id, HTMLElement>());
	const drag = useRef<{
		id: Id;
		pointer: number;
		startX: number;
		startY: number;
		x: number;
		y: number;
	} | null>(null);
	useEffect(() => {
		setCards((previous) =>
			previous.filter((card) => Object.hasOwn(graphs, card.id)),
		);
	}, [graphs]);
	const functions: FunctionInteraction = {
		highlight,
		open(id) {
			activate(id);
			if (id === entryId) {
				entry.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
				entry.current?.focus({ preventScroll: true });
				return;
			}
			if (!Object.hasOwn(graphs, id)) return;
			setCards((previous) => {
				const existing = previous.find((card) => card.id === id);
				// Search empty grid slots; moving a card does not reserve its old slot.
				let slot = 0;
				while (
					previous.some(
						(card) =>
							card.open &&
							Math.abs(card.x - (WIDTH + GAP + (slot % 2) * (WIDTH + GAP))) <
								WIDTH &&
							Math.abs(card.y - Math.floor(slot / 2) * 620) < 600,
					)
				)
					slot++;
				return [
					...previous.filter((card) => card.id !== id),
					existing
						? { ...existing, open: true }
						: {
								id,
								open: true,
								x: WIDTH + GAP + (slot % 2) * (WIDTH + GAP),
								y: Math.floor(slot / 2) * 620,
							},
				];
			});
			requestAnimationFrame(() => {
				const card = elements.current.get(id);
				card?.scrollIntoView({ block: "nearest", inline: "nearest" });
				card?.focus({ preventScroll: true });
			});
		},
	};
	const visible = cards.filter(
		(card) => card.open && Object.hasOwn(graphs, card.id),
	);
	return (
		<div className="function-workspace-scroll">
			<div
				className="function-workspace"
				style={{
					minWidth: Math.max(
						WIDTH,
						...visible.map((card) => card.x + WIDTH + GAP),
					),
					minHeight: Math.max(620, ...visible.map((card) => card.y + 600)),
				}}
			>
				<div
					ref={entry}
					tabIndex={-1}
					className={`function-main${highlighted === entryId ? " function-highlighted" : ""}`}
					data-function-id={entryId}
				>
					{render(entryId, functions)}
				</div>
				{visible.map((card) => (
					<section
						key={card.id}
						ref={(element) => {
							if (element) elements.current.set(card.id, element);
							else elements.current.delete(card.id);
						}}
						tabIndex={-1}
						className={`function-card${highlighted === card.id ? " function-highlighted" : ""}`}
						data-function-id={card.id}
						aria-label={`Function ${graphs[card.id].entry.name}`}
						style={{
							left: card.x,
							top: card.y,
							zIndex: cards.indexOf(card) + 1,
						}}
					>
						<header
							className="function-card-handle"
							onPointerDown={(event) => {
								if (
									event.button !== 0 ||
									(event.target as HTMLElement).closest("button")
								)
									return;
								event.currentTarget.setPointerCapture(event.pointerId);
								drag.current = {
									id: card.id,
									pointer: event.pointerId,
									startX: event.clientX,
									startY: event.clientY,
									x: card.x,
									y: card.y,
								};
								setCards((previous) => [
									...previous.filter((item) => item.id !== card.id),
									card,
								]);
							}}
							onPointerMove={(event) => {
								const moving = drag.current;
								if (!moving || moving.pointer !== event.pointerId) return;
								setCards((previous) =>
									previous.map((item) =>
										item.id === moving.id
											? {
													...item,
													x: Math.max(
														0,
														moving.x + event.clientX - moving.startX,
													),
													y: Math.max(
														0,
														moving.y + event.clientY - moving.startY,
													),
												}
											: item,
									),
								);
							}}
							onPointerUp={() => {
								drag.current = null;
							}}
							onPointerCancel={() => {
								drag.current = null;
							}}
							onLostPointerCapture={() => {
								drag.current = null;
							}}
						>
							<span>{graphs[card.id].entry.name}</span>
							<button
								type="button"
								aria-label={`Close ${graphs[card.id].entry.name}`}
								onClick={() => {
									setCards((previous) =>
										previous.map((item) =>
											item.id === card.id ? { ...item, open: false } : item,
										),
									);
									highlight(null);
									activate(null);
								}}
							>
								×
							</button>
						</header>
						{render(card.id, functions)}
					</section>
				))}
			</div>
		</div>
	);
}
