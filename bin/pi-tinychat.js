#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createTinyChat } from "../src/server.js";
import { locatePi } from "../src/pi-path.js";

const HELP = `Pi TinyChat — Tiny UI. Full Pi. Zero Bloat.

Usage:
  pi-tinychat [options]

Options:
  --cwd <path>    Working directory for Pi (default: current directory)
  --port <port>   Port on 127.0.0.1 (default: $PI_TINYCHAT_PORT or 4310; uses the next free port if taken)
  --no-open       Do not open the browser automatically
  --pi <path>     Path to the pi executable or CLI entry point
  --continue      Resume the most recent Pi session in the directory
  --help          Show this help
  --version       Show the version
`;

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--version" || arg === "-v") options.version = true;
		else if (arg === "--no-open") options.open = false;
		else if (arg === "--continue" || arg === "-c") options.continue = true;
		else if (arg === "--cwd") options.cwd = argv[++index];
		else if (arg === "--port") options.port = Number(argv[++index]);
		else if (arg === "--pi") options.pi = argv[++index];
		else if (!arg.startsWith("-") && !options.cwd) options.cwd = arg;
		else throw new Error(`不明なオプションです: ${arg}`);
	}
	return options;
}

function openBrowser(url) {
	const platform = process.platform;
	/** @type {[string, string[]]} */
	const command =
		platform === "win32"
			? ["cmd", ["/c", "start", "", url]]
			: platform === "darwin"
				? ["open", [url]]
				: ["xdg-open", [url]];
	try {
		const child = spawn(command[0], command[1], {
			stdio: "ignore",
			detached: true,
			windowsHide: true,
		});
		// A missing opener (WSL/containers without xdg-open) only shows up as an
		// async error event; the URL is already printed, so keep the server alive.
		child.on("error", () => {});
		child.unref();
	} catch {
		/* the URL is printed anyway */
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(HELP);
		return;
	}
	if (options.version) {
		const { readFile } = await import("node:fs/promises");
		const pkg = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		);
		process.stdout.write(`${pkg.version}\n`);
		return;
	}

	const cwd = resolve(options.cwd ?? process.cwd());
	if (!existsSync(cwd)) throw new Error(`ディレクトリが見つかりません: ${cwd}`);

	const env = { ...process.env };
	if (options.pi) env.PI_TINYCHAT_PI = options.pi;
	const launcher = locatePi(env);
	const port = Number(options.port ?? process.env.PI_TINYCHAT_PORT ?? 4310);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`ポート番号が不正です: ${options.port}`);
	}

	const app = await createTinyChat({
		cwd,
		launcher,
		env,
		port,
		piArgs: options.continue ? ["--continue"] : [],
	});
	process.stdout.write(`\n  Pi TinyChat  ${app.url}\n  ${cwd}\n\n`);
	if (options.open !== false) openBrowser(app.url);

	let stopping = false;
	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		await app.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((error) => {
	process.stderr.write(`pi-tinychat: ${error.message}\n`);
	process.exit(1);
});
