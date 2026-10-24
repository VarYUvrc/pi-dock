import { expect, test } from "@playwright/test";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { sessionFile, setupWorkspace, startDock, stopDock } from "./harness.js";

const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let workspace;
let dock;
let page;

test.beforeEach(async ({ page: currentPage, context }) => {
	workspace = await setupWorkspace();
	dock = await startDock(workspace);
	page = currentPage;
	page.on("pageerror", (error) => console.log("PAGEERROR:", error.message));
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.goto(dock.url);
	await expect(page.locator("#modelLabel")).toHaveText("Fake Fast");
});

test.afterEach(async () => {
	await stopDock(dock, workspace);
});

const input = () => page.locator("#input");

async function send(text) {
	await input().fill(text);
	await input().press("Control+Enter");
}

async function expectDone() {
	await expect(page.locator("#stopButton")).toBeHidden({ timeout: 15_000 });
}

function elapsedSeconds(text) {
	const match = /^(\d+)h(\d{2})m(\d{2})s$/.exec(text ?? "");
	if (!match) return NaN;
	return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function rpc(command) {
	const response = await page.request.post(`http://127.0.0.1:${dock.port}/api/rpc`, {
		data: command,
		headers: {
			"content-type": "application/json",
			origin: `http://127.0.0.1:${dock.port}`,
			"x-pi-dock-token": dock.token,
		},
	});
	return response.json();
}

test("loads the shell and enforces the token", async () => {
	await expect(page.locator("#projectName")).toHaveText("project");
	await expect(page.locator("#composer")).toBeVisible();
	await expect(page.getByTestId("message-user")).toHaveCount(0);

	// The launch credential is exchanged for a cookie and the address bar is clean.
	expect(new URL(page.url()).search).toBe("");
	expect(new URL(page.url()).pathname).toBe("/");

	const bareStatus = await new Promise((resolve, reject) => {
		const request = httpRequest(
			`http://127.0.0.1:${dock.port}/`,
			{ headers: { host: `127.0.0.1:${dock.port}` } },
			(response) => {
				response.resume();
				resolve(response.statusCode);
			},
		);
		request.on("error", reject);
		request.end();
	});
	expect(bareStatus).toBe(401);
	await page.context().clearCookies();
	const brokenToken = await page.request.get(
		`http://127.0.0.1:${dock.port}/api/events?token=wrong`,
	);
	expect(brokenToken.status()).toBe(401);
});

test("streams a reply with thinking, tools, markdown and copy", async () => {
	await send("hello");
	await expect(page.getByTestId("message-user")).toHaveCount(1);
	await expect(page.getByTestId("message-user")).toHaveText("hello");
	await expect(page.getByTestId("message-live")).toBeVisible();
	await expect(page.getByTestId("message-assistant").last()).toContainText("結果", {
		timeout: 10_000,
	});
	await expectDone();

	// Thinking and tool work are separate compact cards because the assistant
	// text between them is always visible.
	const groups = page.getByTestId("work-group");
	await expect(groups).toHaveCount(2);
	const reasoning = groups.first();
	await expect(reasoning).toHaveAttribute("data-status", "done");
	await expect(reasoning.locator(".work-label")).toHaveText(
		"ユーザーの依頼を確認して、必要なツールを選びます。",
	);
	expect(await reasoning.evaluate((node) => node.open)).toBe(false);
	await reasoning.locator("summary").first().click();
	await expect(reasoning).toContainText("必要なツール");

	const work = groups.last();
	await expect(work).toHaveAttribute("data-status", "done");
	expect(await work.evaluate((node) => node.open)).toBe(false);
	await expect(work.locator(".work-dot.done")).toHaveCount(1);
	await expect(work.locator(".work-label")).toHaveText("作業");
	await expect(work.locator(".work-count, .work-meta")).toHaveCount(0);
	await work.locator("summary").first().click();

	// Nested tool cards stay individually expandable with arguments and output.
	const tool = work.locator('details[data-testid="tool"]').first();
	expect(await tool.evaluate((node) => node.open)).toBe(false);
	await tool.locator("summary").click();
	await expect(tool).toContainText("引数");
	await expect(tool).toContainText("echo hi");
	await expect(tool).toContainText("hi from fake pi");
	await expect(tool.locator(".dot")).toHaveClass(/done/);

	// markdown rendering
	await expect(page.locator(".message-list table")).toContainText("OK");
	await expect(page.locator(".code-block code")).toContainText("const answer = 42;");

	// copy button copies the code
	await page.locator(".code-copy").first().click();
	const clipboard = await page.evaluate(() => navigator.clipboard.readText());
	expect(clipboard).toBe("const answer = 42;");
	const ring = await page.locator("#contextButton").getAttribute("title");
	expect(ring).toContain("コンテキスト");
});

test("groups multiple tools into a stable work rail and keeps failures visible", async () => {
	await send("tools");
	await expect(page.getByTestId("message-assistant").last()).toContainText("すべて完了しました。", {
		timeout: 10_000,
	});
	await expectDone();

	const groups = page.getByTestId("work-group");
	await expect(groups).toHaveCount(2);
	const work = groups.last();
	await expect(work).toHaveAttribute("data-status", "done");
	await expect(work.locator(".work-dot.done")).toHaveCount(3);
	await expect(work.locator(".work-label")).toHaveText("作業");
	const railWidth = await work
		.locator(".work-rail")
		.evaluate((node) => node.getBoundingClientRect().width);
	expect(railWidth).toBeGreaterThan(0);
	await work.locator("summary").first().click();
	await expect(work.getByTestId("tool")).toHaveCount(3);
	await expect(work.getByTestId("tool").first()).toContainText("echo one");

	await send("fail");
	await expect(page.getByTestId("message-assistant").last()).toContainText("失敗しました。", {
		timeout: 10_000,
	});
	await expectDone();
	const failed = page.getByTestId("work-group").last();
	await expect(failed).toHaveAttribute("data-status", "error");
	await expect(failed).toContainText("エラー");
	await expect(failed.locator(".work-rail .work-dot.error")).toHaveCount(1);
	await expect(failed.locator(".work-alert")).toBeVisible();
	expect(await failed.evaluate((node) => node.open)).toBe(false);
	await failed.locator("summary").first().click();
	await expect(failed.getByTestId("tool").first()).toContainText("exit 1");
});

test("uses reasoning as the work heading and falls back quietly", async () => {
	await send("reason");
	await expect(page.getByTestId("message-assistant").last()).toContainText("理由を確認しました。", {
		timeout: 10_000,
	});
	await expectDone();

	const reasoned = page.getByTestId("work-group").last();
	await expect(reasoned.locator(".work-label")).toHaveText(
		"Let me inspect the architecture first.",
	);
	await expect(reasoned.locator(".work-dot.done")).toHaveCount(2);
	await expect(reasoned.locator(".work-count, .work-meta")).toHaveCount(0);

	await send("silent");
	await expect(page.getByTestId("message-assistant").last()).toContainText("静かに完了しました。", {
		timeout: 10_000,
	});
	await expectDone();
	const silent = page.getByTestId("work-group").last();
	await expect(silent.locator(".work-label")).toHaveText("作業");
	await expect(silent.locator(".work-dot.done")).toHaveCount(1);
});

test("keeps an open live work group stable while its heading streams", async () => {
	await send("slowwork");
	const work = page.getByTestId("work-group").first();
	const label = work.locator(".work-label");
	await expect(label).toContainText("Let me examine", { timeout: 10_000 });
	const initial = (await label.textContent())?.length ?? 0;
	await work.locator("summary").first().click();
	await expect(work).toHaveAttribute("open", "");
	await work.evaluate((element) => {
		element.dataset.reuseCheck = "kept";
	});
	await expect
		.poll(async () => (await label.textContent())?.length ?? 0, { timeout: 5000 })
		.toBeGreaterThan(initial);
	await expect(work).toHaveAttribute("data-reuse-check", "kept");
	await expect(page.getByTestId("message-assistant").last()).toContainText(
		"低速の理由を確認しました。",
		{ timeout: 10_000 },
	);
	await expectDone();
});

test("refreshes the context ring while a response is streaming", async () => {
	const button = page.locator("#contextButton");
	const before = await button.getAttribute("title");
	await send("long please");
	await expect(page.getByTestId("message-live")).toContainText("chunk 2");
	await expect(button).toHaveClass(/running/);
	await button.click();
	await expect(page.getByTestId("compact-button")).toHaveCount(0);
	await button.click();
	await expect.poll(() => button.getAttribute("title"), { timeout: 10_000 }).not.toBe(before);
	await expectDone();
	await expect(button).not.toHaveClass(/running/);
	expect(await button.getAttribute("title")).toContain("コンテキスト");
});

test("sets per-model compaction in Pi settings without losing other settings", async () => {
	const settingsFile = join(workspace.agent, "settings.json");
	await writeFile(
		settingsFile,
		`${JSON.stringify(
			{ theme: "dark", compaction: { keepRecentTokens: 12_345 } },
			null,
			2,
		)}\n`,
	);
	await page.reload();
	await expect(page.locator("#modelLabel")).toHaveText("Fake Fast");
	await page.locator("#contextButton").click();
	await expect(page.getByTestId("compaction-25")).toHaveAttribute("aria-pressed", "false");
	await page.getByTestId("compaction-25").click();
	await expect(page.getByTestId("compaction-25")).toHaveAttribute("aria-pressed", "true");
	await expect(page.locator("#contextButton")).toHaveAttribute("title", /自動圧縮 25%/);

	let saved = JSON.parse(await readFile(settingsFile, "utf8"));
	expect(saved.theme).toBe("dark");
	expect(saved.compaction.keepRecentTokens).toBe(12_345);
	expect(saved.compaction.modelOverrides["fake/fake-fast"].reserveTokens).toBe(24_000);

	await page.getByTestId("compaction-toggle").click();
	await expect(page.getByTestId("compaction-toggle")).toHaveAttribute("aria-checked", "false");
	saved = JSON.parse(await readFile(settingsFile, "utf8"));
	expect(saved.compaction.enabled).toBe(false);

	await page.getByTestId("compaction-default").click();
	await expect(page.getByTestId("compaction-25")).toHaveAttribute("aria-pressed", "false");
	saved = JSON.parse(await readFile(settingsFile, "utf8"));
	expect(saved.compaction.modelOverrides).toBeUndefined();
	expect(saved.compaction.keepRecentTokens).toBe(12_345);
});

test("Enter inserts a newline and never sends", async () => {
	await input().fill("line1");
	await input().press("Enter");
	await input().pressSequentially("line2");
	await expect(input()).toHaveValue("line1\nline2");
	await expect(page.getByTestId("message-user")).toHaveCount(0);
});

test("IME confirmation cannot trigger send", async () => {
	await input().fill("にほんご");
	await input().evaluate((element) => {
		const press = (init) =>
			element.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Enter",
					code: "Enter",
					ctrlKey: true,
					bubbles: true,
					cancelable: true,
					...init,
				}),
			);
		element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
		press({ keyCode: 229, which: 229, isComposing: true });
		element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
		press({ keyCode: 13, which: 13 });
	});
	await page.waitForTimeout(250);
	await expect(page.getByTestId("message-user")).toHaveCount(0);
	await expect(input()).toHaveValue("にほんご");

	await input().press("Control+Enter");
	await expect(page.getByTestId("message-user")).toHaveCount(1);
	await expectDone();
});

test("Ctrl+Enter setting is honoured and persisted", async () => {
	await page.addInitScript(() => {
		window.__storageWrites = 0;
		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = function (...args) {
			window.__storageWrites += 1;
			return original.apply(this, args);
		};
	});
	await page.reload();
	await expect(page.locator("#modelLabel")).toHaveText("Fake Fast");

	await page.locator("#settingsButton").click();
	const toggle = page.getByTestId("ctrl-enter-toggle");
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "false");

	await input().fill("button only");
	await input().press("Control+Enter");
	await page.waitForTimeout(300);
	await expect(page.getByTestId("message-user")).toHaveCount(0);

	await page.locator("#sendButton").click();
	await expect(page.getByTestId("message-user")).toHaveCount(1);
	await expectDone();

	const writes = await page.evaluate(() => window.__storageWrites);
	expect(writes).toBe(1);
	const stored = await page.evaluate(() => localStorage.getItem("pi-dock:settings"));
	expect(JSON.parse(stored)).toEqual({ ctrlEnterSend: false, theme: "system" });

	await page.reload();
	await expect(page.locator("#modelLabel")).toHaveText("Fake Fast");
	await page.locator("#settingsButton").click();
	await expect(page.getByTestId("ctrl-enter-toggle")).toHaveAttribute("aria-checked", "false");
});

test("switches theme and follows the system when asked", async () => {
	const html = page.locator("html");
	await expect(html).toHaveAttribute("data-theme", "light");
	await page.locator("#settingsButton").click();
	await expect(page.locator('[data-theme-option="system"]')).toHaveAttribute("aria-pressed", "true");
	await page.locator('[data-theme-option="dark"]').click();
	await expect(html).toHaveAttribute("data-theme", "dark");
	await expect(page.locator("body")).toHaveCSS("background-color", "rgb(20, 19, 18)");

	await page.reload();
	await expect(html).toHaveAttribute("data-theme", "dark");
	await page.locator("#settingsButton").click();
	await expect(page.locator('[data-theme-option="dark"]')).toHaveAttribute("aria-pressed", "true");

	await page.emulateMedia({ colorScheme: "light" });
	await expect(html).toHaveAttribute("data-theme", "dark");
	await page.locator('[data-theme-option="system"]').click();
	await expect(html).toHaveAttribute("data-theme", "light");
	await page.emulateMedia({ colorScheme: "dark" });
	await expect(html).toHaveAttribute("data-theme", "dark");
	await page.emulateMedia({ colorScheme: "light" });
});

test("slash menu lists live Pi commands and inserts one", async () => {
	await input().fill("/");
	await expect(page.getByTestId("slash-item").first()).toBeVisible();
	await expect(page.getByTestId("slash-item").filter({ hasText: "/fix-tests" })).toHaveCount(1);
	await input().pressSequentially("fix");
	await expect(page.getByTestId("slash-item")).toHaveCount(1);
	await expect(page.getByTestId("slash-item").first()).toContainText("Fix failing tests");
	await input().press("Enter");
	await expect(input()).toHaveValue("/fix-tests ");
	await expect(page.getByTestId("message-user")).toHaveCount(0);
	await input().press("Control+Enter");
	await expect(page.getByTestId("message-assistant").last()).toContainText(
		"command accepted: /fix-tests",
	);
});

test("plus menu searches commands and inserts without sending", async () => {
	await expect(page.locator("#planPanel")).toBeVisible();
	await expect(page.getByTestId("plan-item")).toHaveCount(0);
	await page.locator("#commandButton").click();
	await expect(page.locator("#commandMenu")).toBeVisible();
	await expect(page.getByTestId("command-item").filter({ hasText: "/fix-tests" })).toHaveCount(1);
	await expect(page.getByTestId("command-item").filter({ hasText: "/new" })).toHaveCount(1);
	await expect(page.locator("#commandMenu")).toContainText("Prompt");
	await expect(page.locator("#commandMenu")).toContainText("Skill");
	await expect(page.locator("#commandMenu")).toContainText("Extension");
	await expect(page.locator("#commandMenu")).toContainText("Built-in");

	const search = page.locator('[data-role="command-search"]');
	await search.fill("review");
	await expect(page.getByTestId("command-item")).toHaveCount(1);
	await search.evaluate((element) => {
		element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
		element.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Enter",
				code: "Enter",
				keyCode: 229,
				which: 229,
				isComposing: true,
				bubbles: true,
				cancelable: true,
			}),
		);
		element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
	});
	await expect(input()).toHaveValue("");
	await expect(page.locator("#commandMenu")).toBeVisible();
	await page.waitForTimeout(150);
	await search.press("Enter");
	await expect(page.locator("#commandMenu")).toBeHidden();
	await expect(input()).toHaveValue("/skill:review ");
	await expect(page.getByTestId("message-user")).toHaveCount(0);

	await input().fill("");
	await page.locator("#commandButton").click();
	await search.press("ArrowDown");
	await search.press("ArrowDown");
	await search.press("Enter");
	await expect(input()).toHaveValue("/deploy ");
	await input().press("Control+Enter");
	await expect(page.getByTestId("message-assistant").last()).toContainText(
		"command accepted: /deploy",
	);
	await expectDone();

	await input().fill("/");
	await expect(page.getByTestId("slash-item").first()).toBeVisible();
});

test("attaches, pastes, drops and sends images", async () => {
	await page.locator("#imageInput").setInputFiles({
		name: "attached.png",
		mimeType: "image/png",
		buffer: Buffer.from(PNG_BASE64, "base64"),
	});
	await expect(page.getByTestId("attachment")).toHaveCount(1);
	await expect(page.getByTestId("attachment").first().locator("img")).toHaveAttribute(
		"src",
		/^data:image\/png;base64,/,
	);

	await input().evaluate((element, base64) => {
		const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
		const transfer = new DataTransfer();
		transfer.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
		const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", { value: transfer });
		element.dispatchEvent(event);
	}, PNG_BASE64);
	await expect(page.getByTestId("attachment")).toHaveCount(2);

	await page.locator("#composer").evaluate((element, base64) => {
		const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
		const transfer = new DataTransfer();
		transfer.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
		element.dispatchEvent(
			new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
		);
	}, PNG_BASE64);
	await expect(page.getByTestId("attachment")).toHaveCount(3);

	await page.getByTestId("attachment-remove").first().click();
	await expect(page.getByTestId("attachment")).toHaveCount(2);

	await input().fill("look at these");
	await input().press("Control+Enter");
	await expect(page.getByTestId("message-user")).toContainText("look at these");
	await expect(page.getByTestId("message-user").locator("img")).toHaveCount(2);
	await expect(page.locator("#attachments")).toBeHidden();
	await expectDone();
	await expect(page.getByTestId("message-user").locator("img")).toHaveCount(2);
});

test("chooses steer or follow-up while a response is running", async () => {
	await send("long please");
	await expect(page.getByTestId("message-live")).toContainText("chunk 2");
	const mode = page.locator("#sendMode");
	await expect(mode).toBeVisible();

	await page.locator('[data-send-mode="followUp"]').click();
	await expect(page.locator('[data-send-mode="followUp"]')).toHaveAttribute("aria-pressed", "true");
	await input().fill("after this");
	await input().press("Control+Enter");
	await expect(page.locator("#queueBadge")).toHaveText("1 待機");

	await page.locator('[data-send-mode="steer"]').click();
	await input().fill("now this");
	await input().press("Control+Enter");
	await expect(page.locator("#queueBadge")).toHaveText("2 待機");

	await page.locator("#stopButton").click();
	await expectDone();
	await expect(input()).toHaveValue("now this\nafter this");
	await expect(mode).toBeHidden();
});

test("shows, advances and clears the agent plan", async () => {
	await expect(page.locator("#planPanel")).toBeVisible();
	await expect(page.getByTestId("plan-item")).toHaveCount(0);
	await send("plan start");
	await expect(page.locator("#planPanel")).toBeVisible();
	await expect(page.locator("#planTitle")).toHaveText("実装計画");
	await expect(page.getByTestId("plan-item")).toHaveCount(5);
	await expect(page.getByTestId("plan-item").first()).toBeVisible();
	await expect(
		page.getByTestId("plan-item").filter({ hasText: "RPCの確認" }),
	).toHaveAttribute("data-status", "done");
	const integration = page.getByTestId("plan-item").filter({ hasText: "既存機能との統合" });
	await expect(integration).toHaveAttribute("data-status", "in_progress");
	await expect(integration).toHaveAttribute("aria-current", "step");
	await expectDone();

	await send("plan advance");
	await expect(integration).toHaveAttribute("data-status", "done");
	await expect(page.getByTestId("plan-item").filter({ hasText: "E2Eテスト" })).toHaveAttribute(
		"data-status",
		"in_progress",
	);
	await expectDone();

	await send("plan clear");
	await expect(page.locator("#planPanel")).toBeVisible();
	await expect(page.getByTestId("plan-item")).toHaveCount(0);
	await expectDone();
	await page.reload();
	await expect(page.locator("#modelLabel")).toHaveText("Fake Fast");
	await expect(page.locator("#planPanel")).toBeVisible();
	await expect(page.getByTestId("plan-item")).toHaveCount(0);
});

test("keeps the plan on the right and only shows the current plan", async () => {
	const plan = page.locator("#planPanel");
	await expect(plan).toBeVisible();
	await expect(page.getByTestId("plan-item")).toHaveCount(0);
	const chatBox = await page.locator(".chat").boundingBox();
	const planBox = await plan.boundingBox();
	expect(planBox.x).toBeGreaterThan(chatBox.x + chatBox.width - 20);

	await send("plan start");
	await expect(page.getByTestId("plan-item")).toHaveCount(5);
	await expectDone();

	for (let index = 0; index < 3; index += 1) {
		await send("plan advance");
		await expectDone();
	}
	await expect(page.locator(".plan-item.done")).toHaveCount(5);

	// A completed plan belongs to the turn that completed it. A new user
	// message leaves the right panel empty until the agent updates the plan.
	await send("hello");
	await expect(page.getByTestId("message-assistant").last()).toContainText("結果", {
		timeout: 10_000,
	});
	await expect(page.getByTestId("plan-item")).toHaveCount(0);
	await expect(plan).toBeVisible();

	// Continuing the same work brings the same plan back, with a new item.
	await send("plan continue");
	await expect(page.getByTestId("plan-item")).toHaveCount(6);
	await expect(page.getByTestId("plan-item").last()).toHaveAttribute("data-status", "pending");
	await expectDone();

	// A new independent task replaces the plan.
	await send("plan start");
	await expect(page.getByTestId("plan-item")).toHaveCount(5);
	await expect(page.getByTestId("plan-item").last()).toHaveAttribute("data-status", "pending");
	await expectDone();
});

test("opens the plan in a drawer on narrow screens", async () => {
	await page.setViewportSize({ width: 700, height: 900 });
	await expect(page.locator("#planToggle")).toBeVisible();
	await expect
		.poll(async () => (await page.locator("#planPanel").boundingBox()).x)
		.toBeGreaterThanOrEqual(700);

	await page.locator("#planToggle").click();
	await expect(page.locator(".app")).toHaveClass(/plan-open/);
	await expect(page.locator("#planBackdrop")).toBeVisible();
	await expect
		.poll(async () => (await page.locator("#planPanel").boundingBox()).x)
		.toBeLessThan(700);

	await page.locator("#planClose").click();
	await expect(page.locator(".app")).not.toHaveClass(/plan-open/);
	await expect(page.locator("#planBackdrop")).toBeHidden();
});

test("restores only the active branch plan after resuming", async () => {
	const stamp = "2026-01-03T00:00:00.000Z";
	const timestamp = Date.parse(stamp);
	const message = (id, parentId, value) => ({
		type: "message",
		id,
		parentId,
		timestamp: stamp,
		message: { timestamp, ...value },
	});
	const plan = (title, text, status) => ({
		role: "toolResult",
		toolCallId: `call_${title}`,
		toolName: "dock_plan",
		content: [{ type: "text", text }],
		isError: false,
		details: {
			action: "set",
			title,
			items: [{ id: "p1", text, status }],
			nextId: 2,
		},
	});
	const lines = [
		{ type: "session", version: 3, id: "session-branch", timestamp: stamp, cwd: workspace.project },
		message("e1", null, { role: "user", content: "branch root" }),
		message("e2", "e1", plan("Older active plan", "Older step", "done")),
		message("e3", "e2", plan("Active plan", "Active step", "in_progress")),
		message("e4", "e3", {
			role: "assistant",
			content: [{ type: "text", text: "active branch" }],
			stopReason: "stop",
		}),
		message("e5", "e4", { role: "user", content: "abandoned branch" }),
		message("e6", "e5", plan("Abandoned plan", "Abandoned step", "pending")),
		message("e7", "e4", {
			role: "assistant",
			content: [{ type: "text", text: "current leaf" }],
			stopReason: "stop",
		}),
		{
			type: "compaction",
			id: "e8",
			parentId: "e7",
			timestamp: stamp,
			summary: "compacted",
			firstKeptEntryId: "e4",
		},
		{ type: "session_info", id: "e9", parentId: "e8", timestamp: stamp, name: "分岐テスト" },
	];
	await writeFile(
		join(workspace.sessions, "2026-01-03T00-00-00-000Z_branch.jsonl"),
		`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
	);

	await page.locator("#historyButton").click();
	await page.getByTestId("session-item").filter({ hasText: "分岐テスト" }).click();
	await expect(page.locator("#planPanel")).toBeVisible();
	await expect(page.locator("#planTitle")).toHaveText("Active plan");
	await expect(page.getByTestId("plan-item")).toHaveCount(1);
	await expect(page.getByTestId("plan-item")).toContainText("Active step");
	await expect(page.getByTestId("plan-item")).toHaveAttribute("aria-current", "step");
	await expect(page.locator("#planPanel")).not.toContainText("Abandoned");
	await expect(page.locator("#planPanel")).not.toContainText("Older");
});

test("models and thinking levels follow Pi", async () => {
	await page.locator("#modelButton").click();
	await expect(page.getByTestId("model-item")).toHaveCount(2);
	await page.getByTestId("model-item").filter({ hasText: "Fake Reasoner" }).click();
	await expect(page.locator("#modelLabel")).toHaveText("Fake Reasoner");

	await page.locator("#thinkingButton").click();
	await expect(page.getByTestId("thinking-item")).toHaveCount(4);
	await page.getByTestId("thinking-item").filter({ hasText: "high" }).click();
	await expect(page.locator("#thinkingLabel")).toHaveText("high");
	await expect(page.locator("#contextButton")).toHaveAttribute("title", /128,000/);
});

test("resumes a session from the Pi history", async () => {
	await page.locator("#historyButton").click();
	await expect(page.getByTestId("session-item")).toHaveCount(3);
	await expect(page.locator("#sessionList")).toContainText("リファクタ作業");
	await expect(page.locator("#sessionList")).toContainText("過去の会話です");
	await page.getByTestId("session-item").filter({ hasText: "過去の会話です" }).click();
	await expect(page.getByTestId("message-user")).toHaveText("過去の会話です");
	await expect(page.getByTestId("message-assistant")).toContainText("古い応答");
	await expect(page.locator("#historyPanel")).toBeHidden();

	await page.locator("#historyButton").click();
	await page.getByTestId("session-item").filter({ hasText: "リファクタ作業" }).click();
	await expect(page.getByTestId("message-user")).toHaveText("名前付きの会話");
	await expect(page.locator("#sessionName")).toHaveText("リファクタ作業");
});

test("deletes one history item after confirmation", async () => {
	await page.locator("#historyButton").click();
	const target = page.getByTestId("session-item").filter({ hasText: "過去の会話です" });
	await expect(target.getByTestId("session-delete")).toBeVisible();
	await target.getByTestId("session-delete").click();
	const dialog = page.locator("#dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("完全に削除");
	await expect(dialog).toContainText("過去の会話です");
	await page.getByTestId("local-dialog-confirm").click();
	await expect(
		page.getByTestId("session-item").filter({ hasText: "過去の会話です" }),
	).toHaveCount(0);
	await expect(access(workspace.older)).rejects.toThrow();
	await expect(page.locator(".session-item.current").getByTestId("session-delete")).toHaveCount(0);
});

test("selects and deletes all history beyond the old 60 item limit", async () => {
	for (let index = 0; index < 62; index += 1) {
		const id = `bulk-${index}`;
		await writeFile(
			join(workspace.sessions, `2026-02-01T00-00-${String(index).padStart(2, "0")}-000Z_${id}.jsonl`),
			sessionFile({
				id,
				cwd: workspace.project,
				messages: [{ role: "user", content: `bulk ${index}` }],
			}),
		);
	}
	await page.locator("#historyButton").click();
	await expect(page.locator("#sessionList")).toHaveAttribute("data-total", "65");
	await page.locator("#historySelect").click();
	await page.locator("#historySelectAll").click();
	await expect(page.locator("#historyCount")).toHaveText("64 件");
	await page.locator("#historyDelete").click();
	await expect(page.locator("#dialog")).toContainText("64 件");
	await page.getByTestId("local-dialog-confirm").click();
	await expect(
		page.getByTestId("toast").filter({ hasText: "64 件の履歴を削除しました" }),
	).toBeVisible();
	await expect(page.locator("#sessionList")).toHaveAttribute("data-total", "1");
	await expect(page.getByTestId("session-item")).toHaveCount(1);
	expect(await readdir(workspace.sessions)).toEqual([]);
});

test("rejects unknown paths and never deletes another project", async () => {
	const otherDir = join(workspace.agent, "sessions", "--other-project--");
	await mkdir(otherDir, { recursive: true });
	const otherFile = join(otherDir, "2026-01-01T00-00-00-000Z_other.jsonl");
	await writeFile(
		otherFile,
		sessionFile({
			id: "other-project-session",
			cwd: join(workspace.root, "other-project"),
			messages: [{ role: "user", content: "other project" }],
		}),
	);

	const traversal = await rpc({
		type: "dock:delete_sessions",
		ids: ["../../package.json"],
	});
	expect(traversal.ok).toBe(true);
	expect(traversal.data.deleted).toBe(0);
	expect(traversal.data.failed[0].error).toContain("見つかりません");

	const removed = await rpc({ type: "dock:delete_sessions", all: true });
	expect(removed.ok).toBe(true);
	expect(removed.data.deleted).toBe(2);
	await expect(access(otherFile)).resolves.toBeUndefined();
});

test("protects the active session from deletion", async () => {
	const currentFile = join(workspace.sessions, "2026-01-05T00-00-00-000Z_current.jsonl");
	await writeFile(
		currentFile,
		sessionFile({
			id: "fake-session",
			cwd: workspace.project,
			messages: [{ role: "user", content: "current session" }],
		}),
	);
	const result = await rpc({
		type: "dock:delete_sessions",
		ids: ["fake-session"],
	});
	expect(result.ok).toBe(true);
	expect(result.data.deleted).toBe(0);
	expect(result.data.failed[0].error).toContain("使用中");
	await expect(access(currentFile)).resolves.toBeUndefined();
});

test("answers extension dialogs through RPC", async () => {
	await send("please ask");
	const dialog = page.locator("#dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("実行しますか？");
	await dialog.getByRole("button", { name: "はい" }).click();
	await expect(page.locator("#dialogLayer")).toBeHidden();
	await expect(page.getByTestId("message-assistant").last()).toContainText("confirmed=true");

	await send("ask again");
	await expect(page.locator("#dialog")).toBeVisible();
	await page.locator("#dialog").getByRole("button", { name: "キャンセル" }).click();
	await expect(page.getByTestId("message-assistant").last()).toContainText("confirmed=false");
});

test("stops a running response", async () => {
	await send("long please");
	await expect(page.getByTestId("message-live")).toContainText("chunk 3");
	await page.locator("#stopButton").click();
	await expectDone();
	await expect(page.getByTestId("message-live")).toHaveCount(0);
});

test("reload during streaming restores the run", async () => {
	await send("long please");
	await expect(page.getByTestId("message-live")).toContainText("chunk 2");
	await page.reload();
	await expect(page.locator("#modelLabel")).toHaveText("Fake Fast");
	await expect(page.getByTestId("message-live")).toBeVisible();
	await expect(page.getByTestId("message-live")).toContainText("chunk");
	await expect(page.getByTestId("message-user")).toHaveCount(1);
	await expectDone();
	await expect(page.getByTestId("message-assistant")).toHaveCount(1);
});

test("shows the current run elapsed time and keeps it across reloads", async () => {
	await send("long please");
	const elapsed = page.getByTestId("run-elapsed");
	await expect(elapsed).toBeVisible({ timeout: 10_000 });
	await expect(elapsed).toHaveText(/^\d+h\d{2}m\d{2}s$/);
	await expect(elapsed).not.toHaveText("0h00m00s", { timeout: 5000 });
	const before = elapsedSeconds(await elapsed.textContent());

	await input().fill("steer please");
	await input().press("Control+Enter");
	await expect(page.locator("#queueBadge")).toHaveText("1 待機");
	await page.waitForTimeout(1200);
	const after = elapsedSeconds(await elapsed.textContent());
	expect(after).toBeGreaterThanOrEqual(before + 1);

	await page.reload();
	await expect(page.locator("#modelLabel")).toHaveText("Fake Fast");
	const restored = page.getByTestId("run-elapsed");
	await expect(restored).toBeVisible({ timeout: 10_000 });
	await expect(restored).toHaveText(/^\d+h\d{2}m\d{2}s$/);
	await expect(restored).not.toHaveText("0h00m00s");

	await expectDone();
	await expect(page.getByTestId("run-elapsed")).toHaveCount(0);
});

test("sanitises model HTML", async () => {
	await send("xss test");
	await expect(page.getByTestId("message-assistant").last()).toContainText("done", {
		timeout: 10_000,
	});
	const result = await page.evaluate(() => ({
		xss: window.__xss,
		img: document.querySelectorAll('.message-list img[src="x"]').length,
		script: document.querySelectorAll(".message-list script").length,
		link: document.querySelectorAll('.message-list a[href^="javascript"]').length,
	}));
	expect(result).toEqual({ xss: undefined, img: 0, script: 0, link: 0 });
	expect(result.xss).toBeUndefined();
	await expect(page.getByTestId("message-assistant").last()).toContainText("<img src=x");
});

test("starts a new conversation", async () => {
	await send("hello");
	await expect(page.getByTestId("message-assistant").last()).toContainText("結果");
	await page.locator("#historyButton").click();
	await page.locator("#newChatButton").click();
	await expect(page.getByTestId("message-user")).toHaveCount(0);
	await expect(page.getByTestId("message-assistant")).toHaveCount(0);
	await expect(page.locator("#empty")).toBeVisible();
});

test("keeps the previous run alive when starting a new chat", async () => {
	await send("long please");
	await expect(page.getByTestId("message-live")).toContainText("chunk 2");

	await page.locator("#historyButton").click();
	await page.locator("#newChatButton").click();
	await expect(page.getByTestId("message-user")).toHaveCount(0);
	await expect(page.locator("#empty")).toBeVisible();

	// The old session keeps running in the background, independently of the new one.
	await page.locator("#historyButton").click();
	const running = page.getByTestId("session-item").filter({ has: page.locator(".s-run") });
	await expect(running).toHaveCount(1);
	await expect(running).toHaveCount(0, { timeout: 15_000 });

	await page.locator(".session-item:not(.current)").filter({ hasText: "無題の会話" }).click();
	await expect(page.getByTestId("message-user")).toHaveText("long please");
	await expect(page.getByTestId("message-assistant")).toContainText("chunk 129");
});

test("runs Dock built-in slash commands", async () => {
	await input().fill("/compact");
	await input().press("Control+Enter");
	await expect(page.getByTestId("toast").filter({ hasText: "圧縮しました" })).toBeVisible();
	await expect(page.getByTestId("message-user")).toHaveCount(0);

	await input().fill("/name 調査メモ");
	await input().press("Control+Enter");
	await expect(page.locator("#sessionName")).toHaveText("調査メモ");
	await expect(page.getByTestId("message-user")).toHaveCount(0);

	await page.locator("#commandButton").click();
	await page.locator('[data-role="command-search"]').fill("compact");
	await expect(page.getByTestId("command-item")).toHaveCount(1);
	await page.getByTestId("command-item").click();
	await expect(page.getByTestId("toast").filter({ hasText: "圧縮しました" }).last()).toBeVisible();
	await expect(input()).toHaveValue("");
});

test("stopping restores queued steering text", async () => {
	await send("long please");
	await expect(page.getByTestId("message-live")).toContainText("chunk 2");
	await input().fill("keep this for later");
	await input().press("Control+Enter");
	await expect(page.locator("#queueBadge")).toHaveText("1 待機");
	await page.locator("#stopButton").click();
	await expectDone();
	await expect(input()).toHaveValue("keep this for later");
	await expect(page.getByTestId("message-user")).toHaveCount(1);
	await expect(page.locator("#queueBadge")).toBeHidden();
});

test("compacts the context from the menu", async () => {
	await page.locator("#contextButton").click();
	await expect(page.getByTestId("compact-button")).toBeVisible();
	await page.getByTestId("compact-button").click();
	await expect(page.getByTestId("toast").filter({ hasText: "圧縮しました" })).toBeVisible();
	await expect(page.locator("#contextMenu")).toBeHidden();
	// Directly after compaction Pi may have no valid context estimate yet.
	// Show an empty ring without inventing a value or adding a "unknown" label.
	await expect(page.locator("#contextButton")).toHaveClass(/unknown/);
	await expect(page.locator("#contextButton")).toHaveAttribute("title", /コンテキスト/);
	await expect(page.locator("#contextButton")).not.toHaveAttribute("title", /不明/);
	await expect(page.locator("#ringFg")).toHaveAttribute("stroke-dashoffset", "47.12");

	await send("hello");
	await expect(page.getByTestId("message-assistant").last()).toContainText("結果", {
		timeout: 10_000,
	});
	await expect(page.locator("#contextButton")).not.toHaveClass(/unknown/);
});

test("restarts Pi after it exits", async () => {
	await send("die");
	await expect(page.locator("#banner")).toBeVisible({ timeout: 10_000 });
	await expect(page.locator("#bannerText")).toContainText("終了");
	await page.locator("#bannerAction").click();
	await expect(page.locator("#banner")).toBeHidden({ timeout: 20_000 });
	await expect(page.locator("#modelLabel")).toHaveText("Fake Fast");
	await send("hello");
	await expect(page.getByTestId("message-assistant").last()).toContainText("結果");
});

test("blocks cross-origin and bad-host requests", async () => {
	const base = `http://127.0.0.1:${dock.port}`;
	await page.context().clearCookies();
	const noOrigin = await page.request.post(`${base}/api/rpc`, {
		data: { type: "dock:snapshot" },
		headers: { "content-type": "application/json" },
	});
	expect(noOrigin.status()).toBe(401);

	const wrongOrigin = await page.request.post(`${base}/api/rpc`, {
		data: { type: "dock:snapshot" },
		headers: {
			"content-type": "application/json",
			"x-pi-dock-token": dock.token,
			origin: "http://evil.example",
		},
	});
	expect(wrongOrigin.status()).toBe(403);

	const hostStatus = await new Promise((resolve, reject) => {
		const request = httpRequest(
			`${base}/`,
			{ headers: { host: `evil.example:${dock.port}` } },
			(response) => {
				response.resume();
				resolve(response.statusCode);
			},
		);
		request.on("error", reject);
		request.end();
	});
	expect(hostStatus).toBe(421);

	const traversal = await page.request.get(`${base}/..%2fpackage.json?token=${dock.token}`);
	expect(traversal.status()).toBe(404);

	const pageResponse = await page.request.get(dock.url);
	expect(pageResponse.headers()["content-security-policy"]).toContain("default-src 'self'");
	expect(pageResponse.headers()["x-content-type-options"]).toBe("nosniff");
});
