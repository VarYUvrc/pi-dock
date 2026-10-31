import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./test/e2e",
	outputDir: "./tmp/test-results",
	timeout: 30_000,
	fullyParallel: true,
	// Every test gets its own workspace, free port and server, so they can run
	// together. Keep the fan-out small: each test spawns a server and a browser.
	workers: process.env.CI ? 2 : 4,
	reporter: [["list"]],
	use: {
		viewport: { width: 1280, height: 900 },
		locale: "ja-JP",
		deviceScaleFactor: 1,
		screenshot: "only-on-failure",
		trace: "off",
	},
	expect: { timeout: 8_000 },
});
