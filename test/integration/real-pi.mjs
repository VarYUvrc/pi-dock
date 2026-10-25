#!/usr/bin/env node
// Starts Dock against the Pi version installed as a devDependency, with an
// isolated agent directory and no model/network access. This catches RPC,
// session JSONL, and extension-loading drift that the fake fixture cannot.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDock } from "../../src/server.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PI_CLI = join(
	ROOT,
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
	"dist",
	"bundle",
	"cli.js",
);

await mkdir(join(ROOT, "tmp"), { recursive: true });
const root = await mkdtemp(join(ROOT, "tmp", "pi-integration-"));
const agent = join(root, "agent");
const project = join(root, "project");
await mkdir(agent, { recursive: true });
await mkdir(project, { recursive: true });

const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" };
let dock;
let token;
const call = async (command) => {
	const response = await fetch(`http://127.0.0.1:${dock.port}/api/rpc`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-pi-dock-token": token,
		},
		body: JSON.stringify(command),
	});
	const body = await response.json();
	assert.equal(body.ok, true, `${command.type} failed: ${body.errorKey ?? body.error}`);
	return body.data;
};

try {
	dock = await createDock({
		cwd: project,
		launcher: { command: process.execPath, args: [PI_CLI] },
		env,
		port: 0,
	});
	token = new URL(dock.url).searchParams.get("launch");

	const snapshot = await call({ type: "dock:snapshot" });
	assert.equal(snapshot.cwd, project);
	assert.ok(snapshot.state?.sessionId, "Pi did not return a session id");
	assert.ok(snapshot.state?.sessionFile, "Pi did not create a session file");
	assert.ok(Array.isArray(snapshot.commands), "get_commands did not return commands");
	assert.ok(Array.isArray(snapshot.levels) && snapshot.levels.length > 0);

	const commands = await call({ type: "get_commands" });
	assert.ok(Array.isArray(commands.commands));

	const entries = await call({ type: "get_entries" });
	assert.ok(Array.isArray(entries.entries));

	const initialPath = snapshot.state.sessionFile;
	const initialId = snapshot.state.sessionId;
	const created = await call({ type: "new_session" });
	assert.equal(created.cancelled, false);
	const next = await call({ type: "get_state" });
	assert.ok(next.sessionId && next.sessionId !== initialId);
	assert.ok(next.sessionFile && next.sessionFile !== initialPath);

	const sessions = await call({ type: "dock:sessions" });
	assert.ok(sessions.total >= 2, `expected at least two sessions, got ${sessions.total}`);
	const target = sessions.sessions.find((session) => session.id === initialId);
	assert.ok(target?.path, "the initial session is missing from history");

	const switched = await call({ type: "switch_session", sessionPath: target.path });
	assert.equal(switched.cancelled, false);
	const resumed = await call({ type: "get_state" });
	assert.equal(resumed.sessionId, initialId);

	// The dock_plan extension is passed with --extension; reaching this point
	// means Pi loaded it without exiting.
	const planEntry = await call({ type: "get_entries" });
	assert.ok(Array.isArray(planEntry.entries));

	process.stdout.write("real Pi integration ok\n");
} finally {
	await dock?.close().catch(() => {});
	await rm(root, { recursive: true, force: true });
}
