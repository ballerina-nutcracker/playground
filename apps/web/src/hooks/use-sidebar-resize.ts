import * as React from "react";

type SidebarResizeOptions = {
	side?: "left" | "right";
	width: string;
	defaultWidth: string;
	minWidth: string;
	maxWidth: string;
	onResizeEnd: (width: string) => void;
	setIsResizing: (isResizing: boolean) => void;
	resizeRootRef: React.RefObject<HTMLElement | null>;
};

const WIDTH_PATTERN = /^(\d*\.?\d+)\s*(px|rem)$/i;

export function toPixels(width: string): number | null {
	const match = WIDTH_PATTERN.exec(width.trim());
	if (!match) return null;

	const value = Number.parseFloat(match[1]);
	if (!Number.isFinite(value) || value <= 0) return null;

	if (match[2].toLowerCase() === "rem") {
		const rootFontSize = Number.parseFloat(
			getComputedStyle(document.documentElement).fontSize,
		);
		return value * rootFontSize;
	}

	return value;
}

export function isWidthWithinBounds(
	width: string,
	minWidth: string,
	maxWidth: string,
) {
	const widthPx = toPixels(width);
	const minWidthPx = toPixels(minWidth);
	const maxWidthPx = toPixels(maxWidth);
	return (
		widthPx !== null &&
		minWidthPx !== null &&
		maxWidthPx !== null &&
		widthPx >= minWidthPx &&
		widthPx <= maxWidthPx
	);
}

export function useSidebarResize({
	side,
	width,
	defaultWidth,
	minWidth,
	maxWidth,
	onResizeEnd,
	setIsResizing,
	resizeRootRef,
}: SidebarResizeOptions) {
	const railRef = React.useRef<HTMLButtonElement>(null);
	const activePointerIdRef = React.useRef<number | null>(null);
	const startXRef = React.useRef(0);
	const startWidthRef = React.useRef(0);
	const startWidthValueRef = React.useRef(width);
	const pendingWidthRef = React.useRef<string | null>(null);
	const minWidthPxRef = React.useRef<number | null>(null);
	const maxWidthPxRef = React.useRef<number | null>(null);
	const previousUserSelectRef = React.useRef("");
	const optionsRef = React.useRef({
		onResizeEnd,
		setIsResizing,
		resizeRootRef,
	});

	React.useEffect(() => {
		optionsRef.current = { onResizeEnd, setIsResizing, resizeRootRef };
	}, [onResizeEnd, setIsResizing, resizeRootRef]);

	const finishResize = React.useCallback((commit: boolean) => {
		if (activePointerIdRef.current === null) return;

		const pendingWidth = pendingWidthRef.current;
		const { onResizeEnd, resizeRootRef, setIsResizing } = optionsRef.current;
		if (commit && pendingWidth) {
			onResizeEnd(pendingWidth);
		} else if (!commit) {
			resizeRootRef.current?.style.setProperty(
				"--sidebar-width",
				startWidthValueRef.current,
			);
		}

		document.body.style.userSelect = previousUserSelectRef.current;
		activePointerIdRef.current = null;
		pendingWidthRef.current = null;
		minWidthPxRef.current = null;
		maxWidthPxRef.current = null;
		setIsResizing(false);
	}, []);

	React.useEffect(() => {
		const handlePointerMove = (event: PointerEvent) => {
			if (event.pointerId !== activePointerIdRef.current) return;

			const minWidthPx = minWidthPxRef.current;
			const maxWidthPx = maxWidthPxRef.current;
			if (minWidthPx === null || maxWidthPx === null) return;

			const widthPx = Math.max(
				minWidthPx,
				Math.min(
					maxWidthPx,
					startWidthRef.current +
						(side === "right" ? -1 : 1) * (event.clientX - startXRef.current),
				),
			);
			const nextWidth = `${Math.round(widthPx)}px`;
			pendingWidthRef.current = nextWidth;
			optionsRef.current.resizeRootRef.current?.style.setProperty(
				"--sidebar-width",
				nextWidth,
			);
		};
		const handlePointerUp = (event: PointerEvent) => {
			if (event.pointerId === activePointerIdRef.current) finishResize(true);
		};
		const handlePointerCancel = (event: PointerEvent) => {
			if (event.pointerId === activePointerIdRef.current) finishResize(false);
		};

		document.addEventListener("pointermove", handlePointerMove);
		document.addEventListener("pointerup", handlePointerUp);
		document.addEventListener("pointercancel", handlePointerCancel);
		return () => {
			document.removeEventListener("pointermove", handlePointerMove);
			document.removeEventListener("pointerup", handlePointerUp);
			document.removeEventListener("pointercancel", handlePointerCancel);
			finishResize(false);
		};
	}, [finishResize, side]);

	const handleDoubleClick = React.useCallback(
		(event: React.MouseEvent<HTMLButtonElement>) => {
			event.preventDefault();
			const { onResizeEnd, resizeRootRef, setIsResizing } = optionsRef.current;

			setIsResizing(true);
			resizeRootRef.current?.style.setProperty("--sidebar-width", defaultWidth);
			onResizeEnd(defaultWidth);
			requestAnimationFrame(() => {
				requestAnimationFrame(() => setIsResizing(false));
			});
		},
		[defaultWidth],
	);

	const handlePointerDown = React.useCallback(
		(event: React.PointerEvent<HTMLButtonElement>) => {
			if (event.button !== 0) return;

			const currentWidth = toPixels(width);
			const minWidthPx = toPixels(minWidth);
			const maxWidthPx = toPixels(maxWidth);
			if (currentWidth === null || minWidthPx === null || maxWidthPx === null)
				return;

			minWidthPxRef.current = minWidthPx;
			maxWidthPxRef.current = maxWidthPx;
			activePointerIdRef.current = event.pointerId;
			startXRef.current = event.clientX;
			startWidthRef.current = currentWidth;
			startWidthValueRef.current = width;
			previousUserSelectRef.current = document.body.style.userSelect;
			document.body.style.userSelect = "none";
			event.currentTarget.setPointerCapture(event.pointerId);
			optionsRef.current.setIsResizing(true);
			event.preventDefault();
		},
		[width, minWidth, maxWidth],
	);

	return { railRef, handleDoubleClick, handlePointerDown };
}
