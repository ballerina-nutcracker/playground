export const LANGUAGE_SERVER_ROOT = "/workspace";
export const LANGUAGE_SERVER_ROOT_URI = "file:///workspace";

/** Browser paths are rooted namespaces (/tmp, /local), not host paths. */
export function languageServerPath(path: string): string {
	const segments: string[] = [];
	for (const segment of path.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (!segments.length) throw new Error("Path escapes the workspace");
			segments.pop();
		} else {
			segments.push(segment);
		}
	}
	return [LANGUAGE_SERVER_ROOT, ...segments].join("/");
}

export function languageServerUri(path: string): string {
	return `file://${languageServerPath(path).split("/").map(encodeURIComponent).join("/")}`;
}

export function browserPathFromLanguageServerUri(uri: string): string {
	const url = new URL(uri);
	if (url.protocol !== "file:" || url.host || url.search || url.hash) {
		throw new Error("Not a workspace file URI");
	}
	const path = decodeURIComponent(url.pathname);
	if (
		path !== LANGUAGE_SERVER_ROOT &&
		!path.startsWith(`${LANGUAGE_SERVER_ROOT}/`)
	) {
		throw new Error("URI is outside the workspace");
	}
	return path.slice(LANGUAGE_SERVER_ROOT.length) || "/";
}
