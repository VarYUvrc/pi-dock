import { expect, test } from "@playwright/test";
import { request as httpRequest } from "node:http";
import { setupWorkspace, startDock, stopDock } from "./harness.js";

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

test("loads the shell and enforces the token", async () => {
	await expect(page.locator("#projectName")).toHaveText("project");
	await expect(page.locator("#composer")).toBeVisible();
	await expect(page.getByTestId("message-user")).toHaveCount(0);

	const bare = await page.request.get(`http://127.0.0.1:${dock.port}/`);
	expect(bare.status()).toBe(401);
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

	// reasoning is collapsed by default
	const thinking = page.locator('details[data-testid="thinking"]').first();
	await expect(thinking).toBeVisible();
	expect(await thinking.evaluate((node) => node.open)).toBe(false);
	await thinking.locator("summary").click();
	await expect(thinking).toContainText("必要なツール");

	// tool cards are collapsed by default and expand to their output
	const tool = page.locator('details[data-testid="tool"]').first();
	expect(await tool.evaluate((node) => node.open)).toBe(false);
	await tool.locator("summary").click();
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
	await expect(page.getByTestId("session-item")).toHaveCount(2);
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
	await page.locator("#newChatButton").click();
	await expect(page.getByTestId("message-user")).toHaveCount(0);
	await expect(page.getByTestId("message-assistant")).toHaveCount(0);
	await expect(page.locator("#empty")).toBeVisible();
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
