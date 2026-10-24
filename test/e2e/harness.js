import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const FAKE_PI = join(ROOT, "test", "fixtures", "fake-pi.js");

export function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

export function sessionFile({ id, cwd, name, messages }) {
	const stamp = "2026-01-01T00:00:00.000Z";
	const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: stamp, cwd })];
	let parentId = null;
	let index = 0;
	for (const message of messages) {
		const entryId = `e${id}${index++}`;
		lines.push(
			JSON.stringify({
				type: "message",
				id: entryId,
				parentId,
				timestamp: stamp,
				message: { timestamp: Date.parse(stamp), ...message },
			}),
		);
		parentId = entryId;
	}
	if (name) {
		lines.push(
			JSON.stringify({
				type: "session_info",
				id: `s${id}`,
				parentId,
				timestamp: stamp,
				name,
			}),
		);
	}
	return `${lines.join("\n")}\n`;
}

export async function setupWorkspace() {
	const root = await mkdtemp(join(tmpdir(), "pi-dock-e2e-"));
	const project = join(root, "project");
	const agent = join(root, "agent");
	const sessions = join(
		agent,
		"sessions",
		`--${project.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
	);
	await mkdir(project, { recursive: true });
	await mkdir(sessions, { recursive: true });

	const older = join(sessions, "2026-01-01T00-00-00-000Z_old.jsonl");
	const newer = join(sessions, "2026-01-02T00-00-00-000Z_named.jsonl");
	await writeFile(
		older,
		sessionFile({
			id: "session-old",
			cwd: project,
			messages: [
				{ role: "user", content: "過去の会話です" },
				{ role: "assistant", content: [{ type: "text", text: "古い応答" }] },
			],
		}),
	);
	await writeFile(
		newer,
		sessionFile({
			id: "session-named",
			cwd: project,
			name: "リファクタ作業",
			messages: [
				{ role: "user", content: "名前付きの会話" },
				{ role: "assistant", content: [{ type: "text", text: "名前付きの応答" }] },
			],
		}),
	);
	return { root, project, agent, sessions, older, newer };
}

export async function startDock(workspace, extraEnv = {}) {
	const port = await freePort();
	const child = spawn(
		process.execPath,
		[
			join(ROOT, "bin", "pi-dock.js"),
			"--no-open",
			"--port",
			String(port),
			"--cwd",
			workspace.project,
			"--pi",
			FAKE_PI,
		],
		{
			cwd: ROOT,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: workspace.agent,
				...extraEnv,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.stdout.setEncoding("utf8");

	const url = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`dock did not start\n${stderr}`));
		}, 20_000);
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
			const match = /(http:\/\/127\.0\.0\.1:\d+\/\?launch=\S+)/.exec(output);
			if (match) {
				clearTimeout(timer);
				resolve(match[1]);
			}
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`dock exited early (${code})\n${stderr}`));
		});
	});

	return {
		child,
		url,
		port,
		token: new URL(url).searchParams.get("launch"),
		stderr: () => stderr,
	};
}

export async function stopDock(dock, workspace) {
	if (dock?.child && dock.child.exitCode === null) {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/pid", String(dock.child.pid), "/T", "/F"], {
				stdio: "ignore",
			});
		} else {
			dock.child.kill("SIGTERM");
		}
		await new Promise((resolve) => {
			const timer = setTimeout(resolve, 3000);
			dock.child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
	if (workspace?.root) await rm(workspace.root, { recursive: true, force: true });
}
