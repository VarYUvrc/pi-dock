import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LANGUAGES, TRANSLATIONS } from "../public/i18n.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const languages = LANGUAGES.map((entry) => entry.value);
const expected = Object.keys(TRANSLATIONS.en).sort();
let failed = false;

for (const lang of languages) {
	const keys = Object.keys(TRANSLATIONS[lang] ?? {}).sort();
	const missing = expected.filter((key) => !keys.includes(key));
	const extra = keys.filter((key) => !expected.includes(key));
	if (missing.length) {
		failed = true;
		console.error(`${lang}: missing keys: ${missing.join(", ")}`);
	}
	if (extra.length) {
		failed = true;
		console.error(`${lang}: extra keys: ${extra.join(", ")}`);
	}
	for (const key of keys) {
		const value = TRANSLATIONS[lang][key];
		if (typeof value !== "string" || !value.trim()) {
			failed = true;
			console.error(`${lang}: empty value for ${key}`);
		}
	}
}

const used = new Set();
const html = await readFile(join(ROOT, "public", "index.html"), "utf8");
for (const match of html.matchAll(/data-i18n(?:-title|-aria-label|-placeholder)?="([^"]+)"/g)) {
	used.add(match[1]);
}
for (const file of ["app.js", "markdown.js"]) {
	const source = await readFile(join(ROOT, "public", file), "utf8");
	for (const match of source.matchAll(/\bt\("([^"]+)"/g)) used.add(match[1]);
}
for (const key of [...used].sort()) {
	if (!Object.hasOwn(TRANSLATIONS.en, key)) {
		failed = true;
		console.error(`unknown key used in the UI: ${key}`);
	}
}

if (failed) process.exit(1);
console.log(`i18n check ok: ${expected.length} keys × ${languages.length} languages`);
