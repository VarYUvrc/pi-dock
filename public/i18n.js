/**
 * Only user-facing messages are translated: toasts, dialogs, banners, and
 * errors. Static labels, buttons, and tooltips stay in English so the UI
 * vocabulary and this file stay small.
 *
 * Pi model names, tool names, user/assistant text, and Pi/OS errors are not
 * translated. `scripts/check-i18n.mjs` keeps the ja and en key sets aligned.
 */

export const LANGUAGES = [
	{ value: "en", label: "English" },
	{ value: "ja", label: "日本語" },
];

export const TRANSLATIONS = {
	en: {
		"common.delete": "Delete",
		"common.untitled": "Untitled chat",
		"history.deleteTitle": "Delete history",
		"history.deleteAll": "Delete all {count} chats in this project permanently? This cannot be undone.",
		"history.deleteOne": 'Delete "{name}" permanently? This cannot be undone.',
		"history.deleteMany": "Delete {count} chats permanently? This cannot be undone.",
		"history.deletedPartial": "{deleted} deleted, {failed} failed",
		"history.deleted": "{deleted} chats deleted",
		"cmd.noResponse": "There is no response to copy",
		"cmd.copied": "Copied the last response",
		"cmd.exportedPath": "Exported: {path}",
		"cmd.exported": "Exported",
		"cmd.nameRequired": "Enter a name (for example: /name my-task)",
		"cmd.nameSet": "Session name updated",
		"cmd.reloadRunning": "Cannot reload while running",
		"error.extension": "An extension reported an error",
		"error.notConnected": "Not connected to Pi",
		"chat.newCancelled": "New chat cancelled",
		"chat.previousBackground": "The previous chat continues in the background",
		"chat.switchCancelled": "Switch cancelled",
		"chat.cannotResume": "This chat cannot be resumed",
		"compact.running": "Cannot compact while a run is in progress",
		"compact.inProgress": "A compaction is already in progress",
		"compact.done": "Context compacted",
		"image.readFailed": "Could not read the image",
		"image.max": "Up to {count} images",
		"image.tooLarge": "The image is too large",
		"context.saved": "Auto-compaction set to {percent}%",
		"context.reset": "Auto-compaction reset to the Pi default",
		"run.tool.read": "Reading",
		"run.tool.edit": "Editing",
		"run.tool.write": "Writing",
		"run.tool.command": "Running",
		"run.tool.web": "Fetching",
		"run.tool.search": "Searching",
		"run.tool.list": "Listing",
		"run.tool.image": "Viewing",
		"run.tool.plan": "Planning",
		"run.tool.agent": "Delegating",
		"run.tool.tool": "Running",
		"banner.restart": "Restart",
		"banner.connectingPi": "Connecting to Pi…",
		"banner.reconnecting": "Reconnecting to the server…",
		"banner.connectFailed": "Cannot connect to Pi: {message}",
		"banner.retry": "Retry",
		"banner.unauthorized": "Open this page from the launch URL printed in the terminal.",
		"server.notConnected": "Not connected to Pi",
		"server.invalidCommand": "Invalid command",
		"server.sessionNotFound": "Session not found",
		"server.deleteTargetMissing": "No sessions selected for deletion",
		"server.sessionInUse": "A session in use cannot be deleted",
		"server.sessionRunning": "A running session cannot be deleted",
		"server.invalidPath": "Invalid path",
		"server.invalidMessage": "The message is empty",
		"server.invalidImages": "Invalid image",
		"server.invalidModel": "Invalid model",
		"server.invalidLevel": "Invalid reasoning effort",
		"server.invalidName": "Invalid name",
		"server.invalidId": "Invalid id",
		"server.unsupportedCommand": "Unsupported command",
		"server.requestTooLarge": "The request is too large",
		"server.piTimeout": "Pi did not respond in time",
		"server.piLaunch": "Pi is not available",
		"server.noModel": "No model is selected",
		"server.contextUnknown": "The context length is unknown for this model",
		"server.percentRange": "The threshold must be between 1% and 99%",
		"server.invalidSettings": "Invalid settings file",
		"server.readSettings": "Could not read the settings file: {message}",
	},
	ja: {
		"common.delete": "削除",
		"common.untitled": "無題の会話",
		"history.deleteTitle": "履歴を削除",
		"history.deleteAll": "このプロジェクトの履歴 {count} 件を完全に削除します。元に戻せません。",
		"history.deleteOne": "「{name}」を完全に削除します。元に戻せません。",
		"history.deleteMany": "{count} 件の履歴を完全に削除します。元に戻せません。",
		"history.deletedPartial": "{deleted} 件削除、{failed} 件失敗",
		"history.deleted": "{deleted} 件の履歴を削除しました",
		"cmd.noResponse": "コピーする応答がありません",
		"cmd.copied": "最後の応答をコピーしました",
		"cmd.exportedPath": "書き出しました: {path}",
		"cmd.exported": "書き出しました",
		"cmd.nameRequired": "名前を入力してください（例: /name 作業名）",
		"cmd.nameSet": "セッション名を設定しました",
		"cmd.reloadRunning": "実行中は再読み込みできません",
		"error.extension": "拡張でエラーが発生しました",
		"error.notConnected": "Pi に接続されていません",
		"chat.newCancelled": "新しい会話はキャンセルされました",
		"chat.previousBackground": "前の会話はバックグラウンドで継続します",
		"chat.switchCancelled": "切り替えはキャンセルされました",
		"chat.cannotResume": "この会話は再開できません",
		"compact.running": "実行中は圧縮できません",
		"compact.inProgress": "圧縮処理中です",
		"compact.done": "コンテキストを圧縮しました",
		"image.readFailed": "画像を読み込めません",
		"image.max": "画像は {count} 枚までです",
		"image.tooLarge": "画像が大きすぎます",
		"context.saved": "自動圧縮を {percent}% に設定しました",
		"context.reset": "自動圧縮を既定に戻しました",
		"run.tool.read": "読み込み",
		"run.tool.edit": "編集",
		"run.tool.write": "書き込み",
		"run.tool.command": "実行",
		"run.tool.web": "取得",
		"run.tool.search": "検索",
		"run.tool.list": "一覧",
		"run.tool.image": "画像",
		"run.tool.plan": "計画",
		"run.tool.agent": "委任",
		"run.tool.tool": "実行",
		"banner.restart": "再起動",
		"banner.connectingPi": "Pi に接続しています…",
		"banner.reconnecting": "サーバーに再接続しています…",
		"banner.connectFailed": "Pi に接続できません: {message}",
		"banner.retry": "再試行",
		"banner.unauthorized":
			"このページは起動用 URL から開く必要があります。ターミナルに表示された URL を開いてください。",
		"server.notConnected": "Pi に接続されていません",
		"server.invalidCommand": "コマンドが不正です",
		"server.sessionNotFound": "セッションが見つかりません",
		"server.deleteTargetMissing": "削除対象が指定されていません",
		"server.sessionInUse": "使用中のセッションは削除できません",
		"server.sessionRunning": "実行中のセッションは削除できません",
		"server.invalidPath": "パスが不正です",
		"server.invalidMessage": "メッセージが空です",
		"server.invalidImages": "画像の形式が不正です",
		"server.invalidModel": "モデルが不正です",
		"server.invalidLevel": "level が不正です",
		"server.invalidName": "name が不正です",
		"server.invalidId": "id が不正です",
		"server.unsupportedCommand": "未対応のコマンドです",
		"server.requestTooLarge": "リクエストが大きすぎます",
		"server.piTimeout": "Pi の起動がタイムアウトしました",
		"server.piLaunch": "Pi を起動できません",
		"server.noModel": "モデルが選択されていません",
		"server.contextUnknown": "このモデルのコンテキスト長が不明です",
		"server.percentRange": "圧縮しきい値は 1〜99% で指定してください",
		"server.invalidSettings": "設定ファイルの形式が不正です",
		"server.readSettings": "設定を読み込めません: {message}",
	},
};

function detectLanguage() {
	const language = typeof navigator === "object" ? navigator.language : "en";
	return language.toLowerCase().startsWith("ja") ? "ja" : "en";
}

let language = detectLanguage();

export function normalizeLanguage(value) {
	return value === "ja" || value === "en" ? value : null;
}

export function getLanguage() {
	return language;
}

export function t(key, params) {
	const table = TRANSLATIONS[language] ?? TRANSLATIONS.en;
	let value = table[key] ?? TRANSLATIONS.en[key] ?? key;
	if (params && typeof value === "string") {
		value = value.replace(/\{(\w+)\}/g, (match, name) =>
			Object.hasOwn(params, name) ? String(params[name]) : match,
		);
	}
	return value;
}

export function setLanguage(value) {
	language = normalizeLanguage(value) ?? detectLanguage();
	if (typeof document === "object") {
		document.documentElement.lang = language;
	}
	return language;
}
