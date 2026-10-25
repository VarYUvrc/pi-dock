import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REQUIRED = [
	"bin/pi-tinychat.js",
	"src/server.js",
	"public/index.html",
	"public/favicon.svg",
	"public/i18n.js",
	"extension/plan.ts",
];
const FORBIDDEN = ["docs/", "scripts/", "test/", "tmp/", "AGENTS.md", "src/pi-protocol.d.ts"];

await mkdir(join(ROOT, "tmp"), { recursive: true });
const work = await mkdtemp(join(ROOT, "tmp", "pack-"));
try {
	const packed = spawnSync("npm", ["pack", "--pack-destination", work, "--json"], {
		cwd: ROOT,
		encoding: "utf8",
		shell: process.platform === "win32",
	});
	if (packed.status !== 0) throw new Error(packed.stderr || "npm pack failed");
	const info = JSON.parse(packed.stdout)[0];
	const files = info.files.map((entry) => entry.path);
	for (const required of REQUIRED) {
		if (!files.includes(required)) throw new Error(`missing from tarball: ${required}`);
	}
	for (const path of files) {
		if (FORBIDDEN.some((prefix) => path === prefix || path.startsWith(prefix))) {
			throw new Error(`unexpected file in tarball: ${path}`);
		}
	}
	const extracted = join(work, "package");
	await mkdir(extracted, { recursive: true });
	const untar = spawnSync("tar", ["-xzf", info.filename, "-C", "."], {
		cwd: work,
		encoding: "utf8",
	});
	if (untar.status !== 0) throw new Error(untar.stderr || "tar failed");
	const cli = join(extracted, "bin", "pi-tinychat.js");
	const version = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
	if (version.status !== 0 || !/^\d+\.\d+\.\d+/.test(version.stdout)) {
		throw new Error(`--version failed: ${version.stderr || version.stdout}`);
	}
	const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
	if (help.status !== 0 || !help.stdout.includes("pi-tinychat [options]")) {
		throw new Error(`--help failed: ${help.stderr || help.stdout}`);
	}
	const pkg = JSON.parse(await readFile(join(extracted, "package.json"), "utf8"));
	if (pkg.name !== "pi-tinychat") throw new Error("bad package name");
	if (pkg.private === true) throw new Error("package must not be private");
	if (!pkg.keywords?.includes("pi-package")) throw new Error("missing pi-package keyword");
	if (Object.keys(pkg.dependencies ?? {}).length) throw new Error("runtime dependencies must stay empty");
	if (pkg.scripts?.postinstall || pkg.scripts?.preinstall) {
		throw new Error("install scripts are not allowed");
	}
	console.log(`pack check ok: ${files.length} files, ${Math.round(info.size / 1024)} KiB`);
} finally {
	await rm(work, { recursive: true, force: true });
}
