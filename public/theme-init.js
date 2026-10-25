// Applied before the stylesheet so the first paint matches the saved theme.
// This is the only script that reads localStorage before the app boots.
(() => {
	let choice = "system";
	try {
		const raw =
			localStorage.getItem("pi-tinychat:settings") ?? localStorage.getItem("pi-dock:settings");
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed && ["system", "light", "dark"].includes(parsed.theme)) choice = parsed.theme;
		}
	} catch {
		/* storage unavailable */
	}
	const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
	document.documentElement.dataset.theme =
		choice === "system" ? (dark ? "dark" : "light") : choice;
})();
