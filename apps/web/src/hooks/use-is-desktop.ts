import * as React from "react";

const DESKTOP_BREAKPOINT = 1024;

export function useIsDesktop() {
	const [isDesktop, setIsDesktop] = React.useState(
		() =>
			typeof window !== "undefined" &&
			window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT}px)`).matches,
	);

	React.useEffect(() => {
		const mediaQuery = window.matchMedia(
			`(min-width: ${DESKTOP_BREAKPOINT}px)`,
		);
		const onChange = () => setIsDesktop(mediaQuery.matches);
		onChange();
		mediaQuery.addEventListener("change", onChange);
		return () => mediaQuery.removeEventListener("change", onChange);
	}, []);

	return isDesktop;
}
