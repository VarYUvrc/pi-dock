import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const MAX_SEARCH_DEPTH = 30;
const HEAD = "HEAD";
const CHANGE_DEBOUNCE_MS = 80;

/**
 * Locate `.git/HEAD`, walking up from `cwd` so subdirectories of a repository
 * work too. Worktrees and submodules keep `.git` as a file pointing elsewhere.
 */
async function findHeadPath(cwd) {
	let dir = resolve(cwd);
	for (let depth = 0; depth < MAX_SEARCH_DEPTH; depth += 1) {
		const dotGit = join(dir, ".git");
		let info = null;
		try {
			info = await stat(dotGit);
		} catch {
			info = null;
		}
		if (info?.isDirectory()) return join(dotGit, HEAD);
		if (info?.isFile()) {
			const text = await readFile(dotGit, "utf8").catch(() => "");
			const match = /^gitdir:\s*(.+)$/m.exec(text);
			if (!match) return null;
			const target = match[1].trim();
			return join(isAbsolute(target) ? target : resolve(dir, target), HEAD);
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

async function readHead(headPath) {
	const text = await readFile(headPath, "utf8").catch(() => null);
	if (text === null) return "";
	const head = text.trim();
	if (head.startsWith("ref:")) {
		const ref = head.slice("ref:".length).trim();
		return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
	}
	// Detached HEAD: a short commit id still tells the user where they are.
	return head.slice(0, 7);
}

/**
 * Watches `.git/HEAD` instead of polling: checkouts by the agent or by hand
 * arrive as filesystem events, and commits (which do not rewrite HEAD) stay
 * silent. `refresh()` re-resolves the path so `git init` after startup and
 * worktree switches recover without a periodic timer.
 */
export class GitBranchWatcher {
	#cwd;
	/** @type {(branch: string) => void} */
	#onChange;
	#headPath = null;
	#branch = "";
	#watcher = null;
	/** @type {ReturnType<typeof setTimeout> | null} */
	#timer = null;
	#pending = null;
	#queued = false;

	constructor(cwd, onChange = () => {}) {
		this.#cwd = cwd;
		this.#onChange = onChange;
	}

	get branch() {
		return this.#branch;
	}

	start() {
		return this.refresh();
	}

	refresh() {
		if (this.#pending) {
			this.#queued = true;
			return this.#pending;
		}
		this.#pending = this.#run();
		return this.#pending.finally(() => {
			this.#pending = null;
			if (this.#queued) {
				this.#queued = false;
				this.refresh().catch(() => {});
			}
		});
	}

	async #run() {
		const headPath = await findHeadPath(this.#cwd);
		if (headPath !== this.#headPath) {
			this.#headPath = headPath;
			this.#watch(headPath);
		}
		const branch = headPath ? await readHead(headPath) : "";
		if (branch !== this.#branch) {
			this.#branch = branch;
			this.#onChange(branch);
		}
		return branch;
	}

	#watch(headPath) {
		this.#watcher?.close();
		this.#watcher = null;
		if (!headPath) return;
		try {
			// Watch the directory, not HEAD itself: Git replaces HEAD on checkout,
			// which would drop a file watcher on some platforms.
			this.#watcher = watch(dirname(headPath), { persistent: false }, (_event, filename) => {
				if (filename && String(filename).toLowerCase() !== "head") return;
				this.#schedule();
			});
			this.#watcher.on("error", () => {
				this.#watcher?.close();
				this.#watcher = null;
			});
		} catch {
			this.#watcher = null;
		}
	}

	#schedule() {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = null;
			this.refresh().catch(() => {});
		}, CHANGE_DEBOUNCE_MS);
		this.#timer.unref?.();
	}

	close() {
		clearTimeout(this.#timer);
		this.#timer = null;
		this.#watcher?.close();
		this.#watcher = null;
	}
}
