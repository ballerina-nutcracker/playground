export function createFs(inputFiles: Map<string, string>) {
	// Seeded files are older than anything written during a run.
	const modTime = Date.now() - 60_000;
	const modTimes = new Map<string, number>();
	const files = new Map(
		[...inputFiles.entries()].map(([path, content]) => [path, content]),
	);
	const dirs = new Set<string>(["/", "/tmp"]);

	function dirname(path: string) {
		return path.split("/").slice(0, -1).join("/") || "/";
	}

	function basename(path: string) {
		return path.split("/").pop() || "/";
	}

	function ensureDirs(path: string) {
		let dir = path;
		while (!dirs.has(dir)) {
			dirs.add(dir);
			dir = dirname(dir);
		}
	}

	for (const file of files.keys()) {
		ensureDirs(dirname(file));
	}

	return {
		async open(path: string) {
			const content = files.get(path);
			if (content === undefined) return null;
			return {
				content,
				size: content.length,
				modTime: modTimes.get(path) ?? modTime,
				isDir: false,
			};
		},
		async stat(path: string) {
			if (dirs.has(path)) {
				return {
					name: basename(path),
					size: 0,
					modTime,
					isDir: true,
				};
			}

			const content = files.get(path);
			if (content === undefined) return null;
			return {
				name: basename(path),
				size: content.length,
				modTime: modTimes.get(path) ?? modTime,
				isDir: false,
			};
		},
		async readDir(path: string) {
			if (!dirs.has(path)) return null;

			const prefix = path === "/" ? "/" : `${path}/`;
			const entries = new Map<string, { name: string; isDir: boolean }>();

			for (const dir of dirs) {
				if (dir === path || !dir.startsWith(prefix)) continue;
				const name = dir.slice(prefix.length).split("/")[0];
				entries.set(name, { name, isDir: true });
			}

			for (const file of files.keys()) {
				if (!file.startsWith(prefix)) continue;
				const name = file.slice(prefix.length).split("/")[0];
				entries.set(name, entries.get(name) ?? { name, isDir: false });
			}

			return [...entries.values()];
		},
		async writeFile(path: string, content: string, mtime?: number) {
			if (!dirs.has(dirname(path))) return false;
			if (dirs.has(path)) return false;
			files.set(path, content);
			modTimes.set(path, mtime ?? Date.now());
			return true;
		},
		async mkdirAll(path: string) {
			let dir = path;
			while (true) {
				if (files.has(dir)) return false;
				if (dir === "/") break;
				dir = dirname(dir);
			}
			ensureDirs(path);
			return true;
		},
		async remove(path: string) {
			if (files.delete(path)) return true;
			if (!dirs.has(path) || path === "/") return false;
			dirs.delete(path);
			for (const file of [...files.keys()]) {
				if (file.startsWith(`${path}/`)) files.delete(file);
			}
			for (const dir of [...dirs]) {
				if (dir.startsWith(`${path}/`)) dirs.delete(dir);
			}
			return true;
		},
		async move(oldPath: string, newPath: string) {
			if (oldPath === newPath) return true;

			const content = files.get(oldPath);
			if (
				content === undefined ||
				!dirs.has(dirname(newPath)) ||
				dirs.has(newPath)
			)
				return false;
			files.set(newPath, content);
			modTimes.set(newPath, modTimes.get(oldPath) ?? modTime);
			files.delete(oldPath);
			return true;
		},
	};
}
