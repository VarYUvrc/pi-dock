import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

/** @typedef {import("./pi-types.js").PiCommand} PiCommand */
/** @typedef {import("./pi-types.js").PiRecord} PiRecord */
/** @typedef {import("./pi-types.js").PiResponse} PiResponse */

const MAX_STDERR = 8 * 1024;
const DEFAULT_TIMEOUT = 60_000;

/**
 * Minimal client for the official Pi RPC mode.
 *
 * Records are framed on LF only (JSON strings may legally contain U+2028 and
 * U+2029), so this intentionally avoids node:readline.
 */
export class PiBridge extends EventEmitter {
	#process = null;
	#buffer = "";
	/** @type {Map<string, { resolve: (value: any) => void, reject: (reason?: any) => void, timer: NodeJS.Timeout }>} */
	#pending = new Map();
	#sequence = 0;
	#stderr = "";
	#stopping = false;
	#exitInfo = null;
	#launcher;

	constructor({ cwd, launcher, env = process.env, piArgs = [] }) {
		super();
		this.cwd = cwd;
		this.#launcher = launcher;
		this.env = env;
		this.piArgs = piArgs;
	}

	get running() {
		return this.#process !== null && this.#process.exitCode === null;
	}

	get lastExit() {
		return this.#exitInfo;
	}

	start() {
		if (this.#process) return;
		this.#exitInfo = null;
		this.#stderr = "";
		this.#buffer = "";
		this.#stopping = false;

		const args = [...this.#launcher.args, ...this.piArgs, "--mode", "rpc"];
		const child = spawn(this.#launcher.command, args, {
			cwd: this.cwd,
			env: this.env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: Boolean(this.#launcher.shell),
			windowsHide: true,
		});
		this.#process = child;

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => this.#onStdout(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			this.#stderr = (this.#stderr + chunk).slice(-MAX_STDERR);
		});
		child.stdin.on("error", () => {
			/* reported through exit */
		});
		child.once("error", (error) => this.#onExit(null, null, error));
		child.once("exit", (code, signal) => this.#onExit(code, signal));
	}

	#onStdout(chunk) {
		this.#buffer += chunk;
		while (true) {
			const newline = this.#buffer.indexOf("\n");
			if (newline === -1) break;
			const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
			this.#buffer = this.#buffer.slice(newline + 1);
			if (!line) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			this.#dispatch(record);
		}
	}

	/** @param {PiRecord | PiResponse} record */
	#dispatch(record) {
		if (record.type === "response") {
			const pending = this.#pending.get(record.id);
			if (!pending) return;
			this.#pending.delete(record.id);
			clearTimeout(pending.timer);
			if (record.success) {
				pending.resolve("data" in record ? (record.data ?? null) : null);
			} else {
				pending.reject(new Error("error" in record ? record.error : "Pi command failed"));
			}
			return;
		}
		this.emit("record", record);
	}

	#onExit(code, signal, error) {
		const child = this.#process;
		if (!child) return;
		this.#process = null;
		const reason = error
			? `Pi の起動に失敗しました: ${error.message}`
			: `Pi のプロセスが終了しました (code=${code ?? "-"} signal=${signal ?? "-"})`;
		const info = { reason, stderr: this.#stderr, stopping: this.#stopping };
		this.#exitInfo = info;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}
		this.#pending.clear();
		if (!this.#stopping) this.emit("exit", info);
	}

	/**
	 * Send one RPC command and resolve with its `data` payload.
	 * @template {PiCommand} Command
	 * @param {Command} command
	 * @param {{ timeout?: number }} [options]
	 * @returns {Promise<import("./pi-types.js").PiCommandData<Command["type"]>>}
	 */
	request(command, { timeout = DEFAULT_TIMEOUT } = {}) {
		const child = this.#process;
		if (!child || child.exitCode !== null) {
			return Promise.reject(
				new Error(this.#exitInfo?.reason ?? "Pi に接続されていません"),
			);
		}
		if (this.#exitInfo) return Promise.reject(new Error(this.#exitInfo.reason));

		const id = `dock_${++this.#sequence}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`Pi の応答がタイムアウトしました (${command.type})`));
			}, timeout);
			timer.unref?.();
			this.#pending.set(id, { resolve, reject, timer });
			try {
				child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
			} catch (error) {
				this.#pending.delete(id);
				clearTimeout(timer);
				reject(error);
			}
		});
	}

	/**
	 * Send a fire-and-forget record (no response is expected).
	 * @param {PiRecord | PiCommand} record
	 */
	sendRaw(record) {
		const stdin = this.#process?.stdin;
		if (!stdin?.writable) throw new Error("Pi に接続されていません");
		stdin.write(`${JSON.stringify(record)}\n`);
	}

	async stop() {
		const child = this.#process;
		if (!child) return;
		this.#stopping = true;
		await new Promise((resolve) => {
			const done = () => {
				clearTimeout(kill);
				clearTimeout(force);
				resolve();
			};
			const kill = setTimeout(() => child.kill("SIGTERM"), 1500);
			const force = setTimeout(() => child.kill("SIGKILL"), 3000);
			child.once("exit", done);
			try {
				child.stdin.end();
			} catch {
				/* ignore */
			}
		});
		this.#process = null;
	}

	async restart() {
		await this.stop();
		this.start();
	}
}
