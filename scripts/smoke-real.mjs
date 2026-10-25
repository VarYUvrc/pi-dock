#!/usr/bin/env node
// Manual smoke test against the real Pi CLI and the configured model.
// Usage: node scripts/smoke-real.mjs [--cwd <dir>] [prompt...]
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createTinyChat } from "../src/server.js";
import { locatePi } from "../src/pi-path.js";

const argv = process.argv.slice(2);
let cwd = process.cwd();
let message = "Reply with exactly: pong";
if (argv[0] === "--cwd") {
	cwd = resolve(argv[1]);
	message = argv.slice(2).join(" ") || message;
} else if (argv.length) {
	message = argv.join(" ");
}
await mkdir(cwd, { recursive: true });

const app = await createTinyChat({ cwd, launcher: locatePi(), port: 0 });
const token = new URL(app.url).searchParams.get("launch");
const call = async (command) => {
	const response = await fetch(`http://127.0.0.1:${app.port}/api/rpc`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-pi-tinychat-token": token },
		body: JSON.stringify(command),
	});
	const body = await response.json();
	if (!body.ok) throw new Error(body.error);
	return body.data;
};

try {
	const snapshot = await call({ type: "tinychat:snapshot" });
	const model = snapshot.state?.model;
	process.stdout.write(
		`model: ${model ? `${model.provider}/${model.id}` : "(none)"}\n` +
			`thinking: ${snapshot.state?.thinkingLevel} (${snapshot.levels.join(", ")})\n` +
			`models: ${snapshot.models.length}, commands: ${snapshot.commands.length}\n`,
	);
	process.stdout.write(`prompt: ${message}\n`);

	await call({ type: "prompt", message });
	const startedAt = Date.now();
	while (Date.now() - startedAt < 120_000) {
		await new Promise((done) => setTimeout(done, 400));
		if (!(await call({ type: "get_state" })).isStreaming) break;
	}
	const after = await call({ type: "tinychat:snapshot" });
	const answer = after.messages.filter((item) => item.role === "assistant").at(-1);
	const text = (answer?.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	process.stdout.write(`answer: ${text.slice(0, 400)}\n`);
	process.stdout.write(`context: ${JSON.stringify(after.stats?.contextUsage)}\n`);
	process.stdout.write("ok\n");
} finally {
	await app.close();
}
