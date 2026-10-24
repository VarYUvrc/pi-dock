import { statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const CLI_CANDIDATES = [
	["dist", "bundle", "cli.js"],
	["dist", "cli.js"],
];

function isFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function nodeCli(reference) {
	for (const segments of CLI_CANDIDATES) {
		const candidate = join(reference, ...segments);
		if (isFile(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Turn a path to a `pi` launcher into something spawn() can execute directly.
 * npm shims are avoided on Windows (and are slower everywhere), so the real
 * CLI entry point is preferred when it can be located.
 */
function fromLauncher(path) {
	if (/\.(c|m)?js$/i.test(path)) {
		return { command: process.execPath, args: [path], source: path };
	}

	const dir = dirname(path);
	const packageRoots = [
		join(dir, "node_modules", ...PI_PACKAGE.split("/")),
		join(dir, "..", "lib", "node_modules", ...PI_PACKAGE.split("/")),
		join(dir, "..", "..", "lib", "node_modules", ...PI_PACKAGE.split("/")),
	];
	for (const root of packageRoots) {
		const cli = nodeCli(root);
		if (cli) return { command: process.execPath, args: [cli], source: cli };
	}

	return {
		command: path,
		args: [],
		shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(path),
		source: path,
	};
}

/** Locate the installed Pi CLI without installing or copying it. */
export function locatePi(env = process.env) {
	const explicit = env.PI_DOCK_PI?.trim();
	if (explicit) return fromLauncher(explicit);

	const names =
		process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi.bat", "pi"] : ["pi"];
	for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
		for (const name of names) {
			const candidate = join(dir, name);
			if (isFile(candidate)) return fromLauncher(candidate);
		}
	}

	return { command: "pi", args: [], source: "pi (PATH)" };
}
