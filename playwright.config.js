import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./test/e2e",
	outputDir: "./tmp/test-results",
	timeout: 30_000,
	fullyParallel: false,
	workers: 1,
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
