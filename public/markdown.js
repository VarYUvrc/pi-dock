// A deliberately small, escape-first Markdown renderer.
// Every character is HTML-escaped before formatting, so raw HTML in model
// output can never become markup. Only http(s)/mailto/#/relative links survive.

const ESCAPES = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

export function escapeHtml(value) {
	return String(value ?? "").replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

function safeHref(url) {
	const raw = String(url).trim().replace(/^<|>$/g, "");
	if (/^(https?:|mailto:)/i.test(raw)) return raw;
	if (/^[#/]/.test(raw)) return raw;
	return null;
}

const COPY_ICON =
	'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';

function emphasize(text) {
	return text
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
		.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>")
		.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
}

function renderInline(text) {
	const stash = [];
	const keep = (html) => {
		stash.push(html);
		return `\uE000${stash.length - 1}\uE001`;
	};

	let html = escapeHtml(text.trim());
	html = html.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${code}</code>`));
	html = html.replace(/\[([^\]\n]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_match, label, url) => {
		const href = safeHref(url);
		if (!href) return `${label} (${url})`;
		return keep(
			`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${emphasize(label)}</a>`,
		);
	});
	html = html.replace(/(^|[\s(])(https?:\/\/[^\s<>&\uE000]+)/g, (match, lead, url) => {
		const href = safeHref(url);
		if (!href) return match;
		return `${lead}${keep(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`)}`;
	});
	html = emphasize(html);
	html = html.replace(/\n/g, "<br>");
	return html.replace(/\uE000(\d+)\uE001/g, (_, index) => stash[Number(index)]);
}

function codeBlock(code, language) {
	const lang = (language ?? "").replace(/[^\w+#.-]/g, "").slice(0, 20);
	return `<div class="code-block"><div class="code-head">${
		lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : "<span></span>"
	}<button type="button" class="ghost-icon code-copy" aria-label="コードをコピー">${COPY_ICON}</button></div><pre><code>${escapeHtml(
		code.replace(/\n$/, ""),
	)}</code></pre></div>`;
}

function splitRow(row) {
	return row
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
}

function unwrapParagraph(html) {
	const match = /^<p>([\s\S]*)<\/p>$/.exec(html.trim());
	return match && !match[1].includes("<p>") ? match[1] : html;
}

function isBlockStart(line) {
	return (
		/^ {0,3}(```|~~~)/.test(line) ||
		/^ {0,3}#{1,6}\s/.test(line) ||
		/^ {0,3}>/.test(line) ||
		/^ {0,3}([-*+]|\d+[.)])\s+/.test(line) ||
		/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)
	);
}

function listBlock(lines, start) {
	const first = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[start]);
	const baseIndent = first[1].length;
	const ordered = /\d/.test(first[2]);
	const items = [];
	let index = start;

	while (index < lines.length) {
		const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index]);
		if (!match || match[1].length !== baseIndent || /\d/.test(match[2]) !== ordered) break;
		const content = [match[3]];
		index += 1;
		while (index < lines.length) {
			const line = lines[index];
			if (!line.trim()) {
				const next = lines[index + 1];
				if (next && /^\s+\S/.test(next)) {
					content.push("");
					index += 1;
					continue;
				}
				break;
			}
			const indent = /^\s*/.exec(line)[0].length;
			const nestedItem = /^\s*([-*+]|\d+[.)])\s+/.test(line);
			if (indent <= baseIndent) break;
			if (nestedItem && indent < baseIndent + 2) break;
			content.push(line.replace(new RegExp(`^\\s{0,${baseIndent + 2}}`), ""));
			index += 1;
		}
		items.push(unwrapParagraph(renderMarkdown(content.join("\n"))));
	}

	const tag = ordered ? "ol" : "ul";
	const startAttr = ordered && Number.parseInt(first[2], 10) > 1 ? ` start="${Number.parseInt(first[2], 10)}"` : "";
	return {
		html: `<${tag}${startAttr}>${items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`,
		next: index,
	};
}

function tableBlock(lines, start) {
	const header = splitRow(lines[start]);
	const align = splitRow(lines[start + 1]).map((cell) => {
		if (/^:-+:$/.test(cell)) return "center";
		if (/-+:$/.test(cell)) return "right";
		return "";
	});
	const rows = [];
	let index = start + 2;
	while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
		rows.push(splitRow(lines[index]));
		index += 1;
	}
	const cell = (tag, value, column) =>
		`<${tag}${align[column] ? ` class="ta-${align[column]}"` : ""}>${renderInline(value ?? "")}</${tag}>`;
	const head = header.map((value, column) => cell("th", value, column)).join("");
	const body = rows
		.map((row) => `<tr>${header.map((_, column) => cell("td", row[column], column)).join("")}</tr>`)
		.join("");
	return {
		html: `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
		next: index,
	};
}

export function renderMarkdown(markdown) {
	const lines = String(markdown ?? "")
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "    ")
		.split("\n");
	const output = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index];
		if (!line.trim()) {
			index += 1;
			continue;
		}

		const fence = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
		if (fence) {
			const marker = fence[1][0];
			const body = [];
			index += 1;
			while (index < lines.length) {
				const current = lines[index];
				if (new RegExp(`^ {0,3}${marker}{3,}\\s*$`).test(current)) {
					index += 1;
					break;
				}
				body.push(current);
				index += 1;
			}
			output.push(codeBlock(body.join("\n"), fence[2]));
			continue;
		}

		const heading = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
			index += 1;
			continue;
		}

		if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
			output.push("<hr>");
			index += 1;
			continue;
		}

		if (/^ {0,3}>/.test(line)) {
			const quote = [];
			while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
				quote.push(lines[index].replace(/^ {0,3}> ?/, ""));
				index += 1;
			}
			output.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
			continue;
		}

		if (/^ {0,3}([-*+]|\d+[.)])\s+/.test(line)) {
			const list = listBlock(lines, index);
			output.push(list.html);
			index = list.next;
			continue;
		}

		if (
			line.includes("|") &&
			/^ {0,3}\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/.test(lines[index + 1] ?? "")
		) {
			const table = tableBlock(lines, index);
			output.push(table.html);
			index = table.next;
			continue;
		}

		const paragraph = [line];
		index += 1;
		while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
			paragraph.push(lines[index]);
			index += 1;
		}
		output.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
	}

	return output.join("");
}
