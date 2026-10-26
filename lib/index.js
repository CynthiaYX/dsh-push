import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHmac } from "node:crypto";
//#region src/config.ts
/**
* dsh-push 配置加载与 `/push` 配置编辑所需的纯函数。
*
* 配置文件位于 `$DSH_HOME/dsh-push/config.json`，可由 `DSH_PUSH_CONFIG`
* 覆盖。环境变量引用在读取时展开，原始值在写回配置时保持不变。
*/
function resolveDshHome() {
	return process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
}
const DSH_HOME = resolveDshHome();
function configPath() {
	return process.env.DSH_PUSH_CONFIG?.trim() || join(DSH_HOME, "dsh-push", "config.json");
}
function logPath() {
	return join(dirname(configPath()), "push.log");
}
const KNOWN_TYPES = [
	"bark",
	"feishu",
	"wecom",
	"dingtalk",
	"ntfy",
	"webhook"
];
/** Whole-value reference: "$BARK_KEY". */
const ENV_REF = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
/** Embedded reference: "Bearer ${MY_TOKEN}". */
const ENV_INTERPOLATION = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** Resolve environment references in string values, recursively. */
function resolveEnv(value) {
	if (typeof value === "string") {
		const match = ENV_REF.exec(value);
		if (match) return process.env[match[1]] ?? "";
		return value.replace(ENV_INTERPOLATION, (_full, name) => process.env[name] ?? "");
	}
	if (Array.isArray(value)) return value.map(resolveEnv);
	if (value && typeof value === "object") {
		const out = {};
		for (const [key, item] of Object.entries(value)) out[key] = resolveEnv(item);
		return out;
	}
	return value;
}
function bool(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}
function num(value, fallback, min, max) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}
function str(value, fallback) {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}
function strArray(value, fallback) {
	if (!Array.isArray(value)) return fallback;
	const items = value.filter((item) => typeof item === "string" && item.length > 0);
	return items.length > 0 ? items : fallback;
}
function defaultConfig(path) {
	return {
		enabled: true,
		includeSubagents: false,
		timeoutMs: 5e3,
		shutdownTimeoutMs: 2e3,
		dedupeMs: 3e3,
		minDurationSec: 0,
		maxTextChars: 500,
		titleTemplate: "dsh {{status}}",
		template: "dsh {{status}} · {{reason}}",
		events: {
			idle: true,
			interrupted: true,
			needInput: true,
			exit: false
		},
		needInputTools: ["ask_user_question", "exit_plan_mode"],
		debug: false,
		channels: [],
		warnings: [],
		path,
		exists: false
	};
}
function normalizeChannels(raw, warnings) {
	if (raw === void 0) return [];
	if (!Array.isArray(raw)) {
		warnings.push("\"channels\" 必须是数组，已忽略");
		return [];
	}
	const channels = [];
	raw.forEach((item, index) => {
		if (!item || typeof item !== "object") {
			warnings.push(`channels[${index}] 不是对象，已忽略`);
			return;
		}
		const channel = resolveEnv(item);
		if (typeof channel.type !== "string" || !KNOWN_TYPES.includes(channel.type)) {
			warnings.push(`channels[${index}] 未知类型 "${String(channel.type)}"，支持：${KNOWN_TYPES.join(", ")}`);
			return;
		}
		channels.push(channel);
	});
	return channels;
}
let cache;
/** Load the config, reusing the previous parse while the file is unchanged. */
function loadConfig() {
	const path = configPath();
	if (!existsSync(path)) {
		cache = void 0;
		return defaultConfig(path);
	}
	let key;
	try {
		const stat = statSync(path);
		key = `${path}:${stat.mtimeMs}:${stat.size}`;
	} catch {
		key = `${path}:unstatable`;
	}
	if (cache && cache.key === key) return cache.config;
	const config = defaultConfig(path);
	config.exists = true;
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		config.enabled = false;
		config.warnings.push(`config.json 解析失败：${error instanceof Error ? error.message : String(error)}`);
		cache = {
			key,
			config
		};
		return config;
	}
	config.enabled = bool(parsed.enabled, config.enabled);
	config.includeSubagents = bool(parsed.includeSubagents, config.includeSubagents);
	config.timeoutMs = num(parsed.timeoutMs, config.timeoutMs, 200, 6e4);
	config.shutdownTimeoutMs = num(parsed.shutdownTimeoutMs, config.shutdownTimeoutMs, 200, 1e4);
	config.dedupeMs = num(parsed.dedupeMs, config.dedupeMs, 0, 6e5);
	config.minDurationSec = num(parsed.minDurationSec, config.minDurationSec, 0, 86400);
	config.maxTextChars = num(parsed.maxTextChars, config.maxTextChars, 20, 4e3);
	config.titleTemplate = str(parsed.titleTemplate, config.titleTemplate);
	config.template = str(parsed.template, config.template);
	config.needInputTools = strArray(parsed.needInputTools, config.needInputTools);
	config.debug = bool(parsed.debug, config.debug);
	if (parsed.events && typeof parsed.events === "object") {
		const events = parsed.events;
		config.events = {
			idle: bool(events.idle, config.events.idle),
			interrupted: bool(events.interrupted, config.events.interrupted),
			needInput: bool(events.needInput, config.events.needInput),
			exit: bool(events.exit, config.events.exit)
		};
	}
	config.channels = normalizeChannels(parsed.channels, config.warnings);
	if (config.enabled && config.channels.length === 0) config.warnings.push("没有配置任何推送渠道");
	else if (config.enabled && config.channels.every((channel) => channel.enabled === false)) config.warnings.push("所有渠道都是 enabled:false，填好 key 后记得打开");
	cache = {
		key,
		config
	};
	return config;
}
/** Drop the mtime cache so the next read observes disk changes. */
function invalidateConfigCache() {
	cache = void 0;
}
/** Sensitive keys masked by `/push get`. */
const SECRET_KEYS = /* @__PURE__ */ new Set([
	"deviceKey",
	"token",
	"secret",
	"url",
	"Authorization",
	"authorization"
]);
/** Per-type fields users can set via `/push set`. */
const CHANNEL_SETTABLE_FIELDS = {
	bark: [
		"enabled",
		"name",
		"deviceKey",
		"server",
		"sound",
		"group",
		"level",
		"icon",
		"clickUrl",
		"timeoutMs"
	],
	feishu: [
		"enabled",
		"name",
		"url",
		"secret",
		"timeoutMs"
	],
	wecom: [
		"enabled",
		"name",
		"url",
		"timeoutMs"
	],
	dingtalk: [
		"enabled",
		"name",
		"url",
		"secret",
		"timeoutMs"
	],
	ntfy: [
		"enabled",
		"name",
		"topic",
		"server",
		"token",
		"priority",
		"tags",
		"clickUrl",
		"icon",
		"email",
		"timeoutMs"
	],
	webhook: [
		"enabled",
		"name",
		"url",
		"method",
		"timeoutMs"
	]
};
/** Read config.json without environment expansion for in-place edits. */
function loadRawConfig() {
	const path = configPath();
	if (!existsSync(path)) return {
		path,
		exists: false,
		data: {
			enabled: true,
			includeSubagents: false,
			events: {
				idle: true,
				interrupted: true,
				needInput: true,
				exit: false
			},
			channels: []
		}
	};
	try {
		const data = JSON.parse(readFileSync(path, "utf-8"));
		if (!Array.isArray(data.channels)) data.channels = [];
		return {
			path,
			exists: true,
			data
		};
	} catch (error) {
		throw new Error(`config.json 解析失败：${error instanceof Error ? error.message : String(error)}`);
	}
}
/** Write config.json and drop the mtime cache. */
function saveRawConfig(data) {
	const path = configPath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, "	")}\n`, "utf-8");
	invalidateConfigCache();
	return path;
}
function maskSecret(key, value) {
	if (value == null) return "";
	const text = String(value);
	if (!SECRET_KEYS.has(key) && !/token|secret|key|password|authorization/i.test(key)) return text;
	if (text.length === 0) return "(空)";
	if (text.startsWith("$")) return text;
	if (text.length <= 4) return "****";
	return `${"*".repeat(Math.min(8, text.length - 4))}${text.slice(-4)}`;
}
/** Resolve a channel selector to an index in raw.channels. */
function resolveChannelIndex(channels, selector) {
	const sel = selector.trim();
	if (!sel) throw new Error("请指定渠道（type / name / type#N / 序号）");
	if (/^\d+$/.test(sel)) {
		const idx = Number(sel) - 1;
		if (idx < 0 || idx >= channels.length) throw new Error(`渠道序号 ${sel} 超出范围 1..${channels.length || 0}`);
		return idx;
	}
	const hash = /^(?<type>[A-Za-z][A-Za-z0-9_-]*)#(?<n>\d+)$/.exec(sel);
	if (hash?.groups) {
		const type = hash.groups.type.toLowerCase();
		const n = Number(hash.groups.n);
		const matches = channels.map((channel, index) => ({
			channel,
			index
		})).filter(({ channel }) => String(channel.type ?? "").toLowerCase() === type);
		if (matches.length === 0) throw new Error(`没有 type=${type} 的渠道`);
		if (n < 1 || n > matches.length) throw new Error(`${type} 只有 ${matches.length} 个，无法选 #${n}`);
		return matches[n - 1].index;
	}
	const lower = sel.toLowerCase();
	const byName = channels.findIndex((channel) => typeof channel.name === "string" && channel.name.toLowerCase() === lower);
	if (byName >= 0) return byName;
	const byType = channels.map((channel, index) => ({
		channel,
		index
	})).filter(({ channel }) => String(channel.type ?? "").toLowerCase() === lower);
	if (byType.length === 1) return byType[0].index;
	if (byType.length > 1) throw new Error(`type=${sel} 有 ${byType.length} 个，请用 ${sel}#1 或名称区分`);
	throw new Error(`找不到渠道 "${sel}"（可用 /push list 查看）`);
}
function formatChannelLabel(channel, index) {
	const type = String(channel.type ?? "?");
	const name = typeof channel.name === "string" && channel.name.trim() ? channel.name.trim() : "";
	const enabled = channel.enabled === false ? "关" : "开";
	return `${name ? `${name} (${type}#${index + 1})` : `${type}#${index + 1}`} [${enabled}]`;
}
//#endregion
//#region src/command.ts
function usage() {
	return [
		"用法:",
		"  /push                         状态",
		"  /push list                    列出渠道",
		"  /push get <渠道>              查看渠道配置（密钥脱敏）",
		"  /push enable <渠道>           开启渠道并写回 config.json",
		"  /push disable <渠道>          关闭渠道",
		"  /push set <渠道> k=v [k=v…]   设置字段（topic/token/deviceKey/url…）",
		"  /push test [渠道]             测试（可只测一个渠道）",
		"  /push on | off                仅当前插件总开关（不写盘）",
		"  /push events [k=on|off…]      查看/设置全局事件开关",
		"  /push help                    帮助",
		"",
		"渠道选择器: type(ntfy) | name | type#N(ntfy#1) | 序号(1起)",
		"示例:",
		"  /push set ntfy topic=my-topic token=tk_xxx enabled=true",
		"  /push enable ntfy",
		"  /push set bark deviceKey=xxx server=https://api.day.app",
		"  /push disable feishu",
		"  /push test ntfy"
	].join("\n");
}
/** Split args on whitespace; supports simple quoted values. */
function tokenize(args) {
	const out = [];
	for (const match of args.matchAll(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g)) {
		let token = match[0];
		if (token.startsWith("\"") && token.endsWith("\"") || token.startsWith("'") && token.endsWith("'")) token = token.slice(1, -1).replace(/\\([\\'”])/g, "$1");
		out.push(token);
	}
	return out;
}
function parseBool(raw) {
	const value = raw.trim().toLowerCase();
	if ([
		"1",
		"true",
		"on",
		"yes",
		"开",
		"启用"
	].includes(value)) return true;
	if ([
		"0",
		"false",
		"off",
		"no",
		"关",
		"禁用"
	].includes(value)) return false;
	throw new Error(`无法解析布尔值: ${raw}（用 true/false 或 on/off）`);
}
function coerceField(key, raw) {
	if (key === "enabled") return parseBool(raw);
	if (key === "timeoutMs" || key === "priority") {
		if (/^\d+$/.test(raw)) return Number(raw);
		return raw;
	}
	if (key === "tags") return raw;
	return raw;
}
function ensureChannels(data) {
	if (!Array.isArray(data.channels)) data.channels = [];
	return data.channels;
}
function applyPairs(channel, pairs) {
	const type = String(channel.type ?? "");
	const allowed = /* @__PURE__ */ new Set([
		...CHANNEL_SETTABLE_FIELDS[type] ?? [
			"enabled",
			"name",
			"timeoutMs"
		],
		"enabled",
		"name",
		"timeoutMs"
	]);
	const changed = [];
	for (const pair of pairs) {
		const equals = pair.indexOf("=");
		if (equals <= 0) throw new Error(`参数应为 key=value，收到: ${pair}`);
		const key = pair.slice(0, equals).trim();
		const value = pair.slice(equals + 1);
		if (!key) throw new Error(`参数应为 key=value，收到: ${pair}`);
		if (!allowed.has(key)) throw new Error(`渠道 ${type} 不支持字段 "${key}"。可设: ${[...allowed].sort().join(", ")}`);
		channel[key] = coerceField(key, value);
		changed.push(key);
	}
	if (changed.length === 0) throw new Error("请至少提供一个 key=value");
	return changed;
}
function describeChannel(channel, index) {
	const lines = [formatChannelLabel(channel, index)];
	const fields = CHANNEL_SETTABLE_FIELDS[String(channel.type ?? "")] ?? Object.keys(channel);
	for (const key of fields) {
		if (!(key in channel) && key !== "enabled") continue;
		const value = key === "enabled" ? channel.enabled !== false : channel[key];
		if (value === void 0) continue;
		const shown = typeof value === "boolean" ? value ? "true" : "false" : maskSecret(key, value);
		lines.push(`  ${key}=${shown}`);
	}
	return lines.join("\n");
}
function statusText(config, runtimeEnabled, last, describeResults) {
	const lines = [
		`dsh-push: ${runtimeEnabled && config.enabled ? "已启用" : "已停用"}${config.exists ? "" : "（无配置文件）"}`,
		`配置: ${config.path}`,
		`渠道: ${config.channels.length === 0 ? "(空)" : config.channels.map((channel, index) => {
			return `${channel.name?.trim() || `${channel.type}#${index + 1}`}${channel.enabled === false ? "(关)" : ""}`;
		}).join(", ")}`,
		`事件: ${[
			"idle",
			"interrupted",
			"needInput",
			"exit"
		].map((key) => `${key}=${config.events[key] ? "on" : "off"}`).join(" ")}`
	];
	if (last && describeResults) lines.push(`上次推送: ${new Date(last.at).toTimeString().slice(0, 8)} ${last.event} → ${describeResults(last.results)}`);
	else lines.push("上次推送: (无)");
	if (config.warnings.length > 0) lines.push(`警告: ${config.warnings.join("; ")}`);
	lines.push("提示: /push help");
	return lines.join("\n");
}
function handlePushCommand(args, options) {
	const tokens = tokenize(args.trim());
	const action = (tokens[0] ?? "").toLowerCase();
	if (!action) {
		invalidateConfigCache();
		return {
			ok: true,
			message: statusText(loadConfig(), options.runtimeEnabled, options.last, options.describeResults)
		};
	}
	if (action === "help" || action === "-h" || action === "--help") return {
		ok: true,
		message: usage()
	};
	if (action === "on" || action === "off") {
		options.setRuntimeEnabled(action === "on");
		return {
			ok: true,
			message: `dsh-push 已${action === "on" ? "开启" : "关闭"}（仅当前会话，不写 config.json）`
		};
	}
	if (action === "list") {
		const { data } = loadRawConfig();
		const channels = ensureChannels(data);
		if (channels.length === 0) return {
			ok: true,
			message: "没有配置任何渠道"
		};
		return {
			ok: true,
			message: channels.map((channel, index) => {
				const type = String(channel.type ?? "?");
				const extra = type === "ntfy" && channel.topic ? ` topic=${maskSecret("topic", channel.topic)}` : type === "bark" && channel.deviceKey ? ` deviceKey=${maskSecret("deviceKey", channel.deviceKey)}` : type === "webhook" && channel.url ? ` url=${maskSecret("url", channel.url)}` : channel.url ? ` url=${maskSecret("url", channel.url)}` : "";
				return `${index + 1}. ${formatChannelLabel(channel, index)}${extra}`;
			}).join("\n")
		};
	}
	if (action === "get") {
		const selector = tokens[1];
		if (!selector) return {
			ok: false,
			message: "用法: /push get <渠道>\n" + usage()
		};
		const { data } = loadRawConfig();
		const channels = ensureChannels(data);
		const index = resolveChannelIndex(channels, selector);
		return {
			ok: true,
			message: describeChannel(channels[index], index)
		};
	}
	if (action === "enable" || action === "disable") {
		const selector = tokens[1];
		if (!selector) return {
			ok: false,
			message: `用法: /push ${action} <渠道>\n` + usage()
		};
		const raw = loadRawConfig();
		const channels = ensureChannels(raw.data);
		const index = resolveChannelIndex(channels, selector);
		channels[index].enabled = action === "enable";
		const path = saveRawConfig(raw.data);
		const label = formatChannelLabel(channels[index], index);
		return {
			ok: true,
			message: `已${action === "enable" ? "开启" : "关闭"} ${label}\n已写入 ${path}`
		};
	}
	if (action === "set") {
		const selector = tokens[1];
		const pairs = tokens.slice(2);
		if (!selector || pairs.length === 0) return {
			ok: false,
			message: "用法: /push set <渠道> key=value [key=value…]\n" + usage()
		};
		const raw = loadRawConfig();
		const channels = ensureChannels(raw.data);
		const index = resolveChannelIndex(channels, selector);
		const changed = applyPairs(channels[index], pairs);
		const path = saveRawConfig(raw.data);
		return {
			ok: true,
			message: `已更新 ${formatChannelLabel(channels[index], index)}\n${changed.map((key) => `${key}=${maskSecret(key, channels[index][key])}`).join(" ")}\n已写入 ${path}`
		};
	}
	if (action === "events") {
		const pairs = tokens.slice(1);
		const raw = loadRawConfig();
		if (!raw.data.events || typeof raw.data.events !== "object") raw.data.events = {
			idle: true,
			interrupted: true,
			needInput: true,
			exit: false
		};
		const events = raw.data.events;
		if (pairs.length === 0) return {
			ok: true,
			message: `事件: ${[
				"idle",
				"interrupted",
				"needInput",
				"exit"
			].map((key) => `${key}=${events[key] ? "on" : "off"}`).join(" ")}`
		};
		for (const pair of pairs) {
			const equals = pair.indexOf("=");
			if (equals <= 0) throw new Error(`参数应为 event=on|off，收到: ${pair}`);
			const key = pair.slice(0, equals).trim();
			const value = pair.slice(equals + 1);
			if (![
				"idle",
				"interrupted",
				"needInput",
				"exit"
			].includes(key)) throw new Error(`未知事件 "${key}"（idle|interrupted|needInput|exit）`);
			events[key] = parseBool(value);
		}
		const path = saveRawConfig(raw.data);
		return {
			ok: true,
			message: `事件已更新: ${[
				"idle",
				"interrupted",
				"needInput",
				"exit"
			].map((key) => `${key}=${events[key] ? "on" : "off"}`).join(" ")}\n已写入 ${path}`
		};
	}
	if (action === "test") return {
		ok: true,
		message: "",
		runTest: true,
		testFilter: tokens[1] || void 0
	};
	if (KNOWN_TYPES.includes(action) && tokens.length >= 2) return {
		ok: false,
		message: `请使用子命令。试试:\n  /push set ${action} ${tokens.slice(1).join(" ")}\n  /push enable ${action}\n\n` + usage()
	};
	return {
		ok: false,
		message: `未知子命令 "${action}"\n` + usage()
	};
}
/** Restrict a test to one raw channel index without writing the configuration. */
function filterConfigToChannel(config, selector) {
	const channels = ensureChannels(loadRawConfig().data);
	const index = resolveChannelIndex(channels, selector);
	if (config.channels.length !== channels.length) {
		const target = channels[index];
		const type = String(target.type ?? "");
		const name = typeof target.name === "string" ? target.name : void 0;
		return {
			...config,
			channels: config.channels.map((channel) => ({
				...channel,
				enabled: name && channel.name === name || !name && channel.type === type
			}))
		};
	}
	return {
		...config,
		channels: config.channels.map((channel, channelIndex) => ({
			...channel,
			enabled: channelIndex === index
		}))
	};
}
//#endregion
//#region src/http.ts
const MAX_BODY_ECHO = 300;
async function httpRequest(url, init, timeoutMs) {
	const startedAt = Date.now();
	try {
		const response = await fetch(url, {
			method: init.method ?? "POST",
			headers: init.headers,
			body: init.body,
			signal: AbortSignal.timeout(timeoutMs)
		});
		const text = await response.text();
		return {
			ok: response.ok,
			status: response.status,
			body: text.slice(0, MAX_BODY_ECHO),
			error: response.ok ? void 0 : `HTTP ${response.status}`,
			ms: Date.now() - startedAt
		};
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		return {
			ok: false,
			status: 0,
			body: "",
			error: name === "TimeoutError" || name === "AbortError" ? `timeout after ${timeoutMs}ms` : error instanceof Error ? error.message : String(error),
			ms: Date.now() - startedAt
		};
	}
}
/** A local failure (bad config) shaped like an HttpResult. */
function localFailure(message) {
	return {
		ok: false,
		status: 0,
		body: "",
		error: message,
		ms: 0
	};
}
function toChannelResult(name, result) {
	return {
		channel: name,
		ok: result.ok,
		status: result.status,
		error: result.error,
		ms: result.ms
	};
}
/**
* Group-bot endpoints answer HTTP 200 even when they reject the message
* (missing keyword, bad signature, rate limit). Fold that into `ok`.
*/
function applyApiStatus(result, pick) {
	if (!result.ok || !result.body) return result;
	let payload;
	try {
		payload = JSON.parse(result.body);
	} catch {
		return result;
	}
	const verdict = pick(payload);
	if (!verdict || verdict.ok) return result;
	return {
		...result,
		ok: false,
		error: verdict.message ?? "API 返回失败"
	};
}
//#endregion
//#region src/channels/bark.ts
/**
* pi-agent-push — Bark (iOS) channel.
*
* Uses the `POST /:device_key` route with a JSON body, which bark-server
* supports in both V1 and V2 (V2 registers it as a compatibility route), so
* self-hosted servers keep working.
*/
const DEFAULT_SERVER$1 = "https://api.day.app";
async function sendBark(channel, payload, timeoutMs) {
	const deviceKey = (channel.deviceKey ?? "").trim();
	if (!deviceKey) return localFailure("bark: deviceKey 为空");
	const server = (channel.server ?? DEFAULT_SERVER$1).trim().replace(/\/+$/, "");
	const body = {
		title: payload.title,
		body: payload.text
	};
	if (channel.group) body.group = channel.group;
	if (channel.sound) body.sound = channel.sound;
	if (channel.level) body.level = channel.level;
	if (channel.icon) body.icon = channel.icon;
	if (channel.clickUrl) body.url = channel.clickUrl;
	return applyApiStatus(await httpRequest(`${server}/${encodeURIComponent(deviceKey)}`, {
		method: "POST",
		headers: { "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify(body)
	}, timeoutMs), (data) => {
		const code = data.code;
		if (typeof code !== "number" || code === 200) return { ok: true };
		return {
			ok: false,
			message: `bark code=${code} ${String(data.message ?? "")}`.trim()
		};
	});
}
//#endregion
//#region src/channels/groupbot.ts
/**
* pi-agent-push — 飞书 / 企业微信 / 钉钉 group bots.
*
* All three send plain text (`msg_type`/`msgtype` = "text"). The two signing
* schemes differ and are easy to mix up:
*
*   飞书:   key = `${timestampSec}\n${secret}`, message = ""            → body fields
*   钉钉:   key = secret, message = `${timestampMs}\n${secret}`         → query params
*/
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
function feishuSign(timestampSec, secret) {
	return createHmac("sha256", `${timestampSec}\n${secret}`).update("").digest("base64");
}
function dingtalkSign(timestampMs, secret) {
	return createHmac("sha256", secret).update(`${timestampMs}\n${secret}`).digest("base64");
}
async function sendFeishu(channel, payload, timeoutMs) {
	const url = (channel.url ?? "").trim();
	if (!url) return localFailure("feishu: url 为空");
	const body = {
		msg_type: "text",
		content: { text: payload.text }
	};
	const secret = (channel.secret ?? "").trim();
	if (secret) {
		const timestamp = Math.floor(Date.now() / 1e3).toString();
		body.timestamp = timestamp;
		body.sign = feishuSign(timestamp, secret);
	}
	return applyApiStatus(await httpRequest(url, {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify(body)
	}, timeoutMs), (data) => {
		const code = typeof data.code === "number" ? data.code : data.StatusCode;
		if (typeof code !== "number" || code === 0) return { ok: true };
		const message = data.msg ?? data.StatusMessage ?? "";
		return {
			ok: false,
			message: `feishu code=${code} ${String(message)}`.trim()
		};
	});
}
async function sendWecom(channel, payload, timeoutMs) {
	const url = (channel.url ?? "").trim();
	if (!url) return localFailure("wecom: url 为空");
	return applyApiStatus(await httpRequest(url, {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({
			msgtype: "text",
			text: { content: payload.text }
		})
	}, timeoutMs), (data) => {
		const code = data.errcode;
		if (typeof code !== "number" || code === 0) return { ok: true };
		return {
			ok: false,
			message: `wecom errcode=${code} ${String(data.errmsg ?? "")}`.trim()
		};
	});
}
async function sendDingtalk(channel, payload, timeoutMs) {
	const rawUrl = (channel.url ?? "").trim();
	if (!rawUrl) return localFailure("dingtalk: url 为空");
	let url = rawUrl;
	const secret = (channel.secret ?? "").trim();
	if (secret) {
		const timestamp = Date.now().toString();
		const sign = dingtalkSign(timestamp, secret);
		const separator = url.includes("?") ? "&" : "?";
		url = `${url}${separator}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
	}
	return applyApiStatus(await httpRequest(url, {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({
			msgtype: "text",
			text: { content: payload.text }
		})
	}, timeoutMs), (data) => {
		const code = data.errcode;
		if (typeof code !== "number" || code === 0) return { ok: true };
		return {
			ok: false,
			message: `dingtalk errcode=${code} ${String(data.errmsg ?? "")}`.trim()
		};
	});
}
//#endregion
//#region src/channels/ntfy.ts
/**
* pi-agent-push — ntfy channel (https://ntfy.sh / self-hosted).
*
* Body is plain text only (`message` / payload.text). No JSON envelope.
* Optional priority / tags / click / icon go as HTTP headers so they do not
* pollute the notification body.
*/
const DEFAULT_SERVER = "https://ntfy.sh";
async function sendNtfy(channel, payload, timeoutMs) {
	const topic = (channel.topic ?? "").trim();
	if (!topic) return localFailure("ntfy: topic 为空");
	const server = (channel.server ?? DEFAULT_SERVER).trim().replace(/\/+$/, "");
	const headers = { "Content-Type": "text/plain; charset=utf-8" };
	const token = (channel.token ?? "").trim();
	if (token) headers.Authorization = token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
	if (channel.priority != null && channel.priority !== "") headers.Priority = String(channel.priority);
	if (channel.tags != null) {
		const tags = Array.isArray(channel.tags) ? channel.tags.join(",") : String(channel.tags);
		if (tags.trim()) headers.Tags = tags;
	}
	if (channel.clickUrl) headers.Click = channel.clickUrl;
	if (channel.icon) headers.Icon = channel.icon;
	if (channel.email) headers.Email = channel.email;
	const url = `${server}/${encodeURIComponent(topic)}`;
	const body = payload.text;
	const result = await httpRequest(url, {
		method: "POST",
		headers,
		body
	}, timeoutMs);
	if (!result.ok) {
		let detail = result.error ?? `HTTP ${result.status}`;
		if (result.body) try {
			const data = JSON.parse(result.body);
			detail = data.error || data.message || detail;
		} catch {
			detail = result.body.slice(0, 200) || detail;
		}
		return {
			...result,
			error: `ntfy ${detail}`
		};
	}
	return result;
}
//#endregion
//#region src/render.ts
/**
* pi-agent-push — `{{placeholder}}` substitution.
*
* Escaping matters: a raw string template that lands inside JSON must have its
* values JSON-escaped, otherwise a quote or newline in an error message
* produces an invalid request body. Object templates avoid the problem
* entirely (substitute first, stringify after) and are the recommended form.
*/
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
function escapeValue(value, mode) {
	if (mode === "json") return JSON.stringify(value).slice(1, -1);
	if (mode === "url") return encodeURIComponent(value);
	return value;
}
/** Replace `{{name}}` in `template`. Unknown names collapse to "". */
function render(template, vars, mode = "none") {
	return template.replace(PLACEHOLDER, (_match, name) => escapeValue(vars[name] ?? "", mode));
}
/** Recursively render every string inside an object/array template. */
function renderDeep(value, vars) {
	if (typeof value === "string") return render(value, vars);
	if (Array.isArray(value)) return value.map((item) => renderDeep(item, vars));
	if (value && typeof value === "object") {
		const out = {};
		for (const [key, item] of Object.entries(value)) out[render(key, vars)] = renderDeep(item, vars);
		return out;
	}
	return value;
}
/** Format a millisecond duration as `1h2m`, `3m12s` or `12s`. */
function formatDuration(ms) {
	const totalSeconds = Math.max(0, Math.round(ms / 1e3));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`;
}
/** First non-empty line, trimmed and capped — used for error messages. */
function firstLine(text, max) {
	if (!text) return "";
	const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
function pickString(source, key) {
	if (!source || typeof source !== "object") return "";
	const value = source[key];
	return typeof value === "string" ? value : "";
}
/**
* Turn a provider error into something worth reading on a phone.
*
* pi surfaces raw upstream bodies, e.g.
*   `401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`
* which becomes `401 authentication_error: invalid x-api-key`.
*/
function summarizeError(raw, max) {
	if (!raw) return "";
	const text = raw.trim();
	const braceIndex = text.indexOf("{");
	if (braceIndex >= 0) try {
		const parsed = JSON.parse(text.slice(braceIndex));
		const nested = parsed.error ?? parsed;
		const message = pickString(nested, "message") || pickString(parsed, "message");
		const detail = [pickString(nested, "type") || pickString(nested, "code"), message].filter((part) => part.length > 0).join(": ");
		if (detail) {
			const prefix = text.slice(0, braceIndex).trim();
			const combined = prefix ? `${prefix} ${detail}` : detail;
			return combined.length > max ? `${combined.slice(0, max - 1)}…` : combined;
		}
	} catch {}
	return firstLine(text, max);
}
//#endregion
//#region src/channels/webhook.ts
/**
* pi-agent-push — generic webhook channel.
*
* `body` as an object is the recommended form: placeholders are substituted
* into the parsed structure and the result is serialised afterwards, so a
* quote or newline inside an error message can never break the JSON. A string
* `body` is still supported and gets escaped according to `contentType`.
*/
const DEFAULT_CONTENT_TYPE = "application/json; charset=utf-8";
async function sendWebhook(channel, payload, timeoutMs) {
	const rawUrl = (channel.url ?? "").trim();
	if (!rawUrl) return localFailure("webhook: url 为空");
	const vars = payload.vars;
	const url = render(rawUrl, vars, "url");
	const method = (channel.method ?? "POST").toUpperCase();
	const contentType = channel.contentType ?? DEFAULT_CONTENT_TYPE;
	const isJson = contentType.toLowerCase().includes("json");
	const headers = {};
	for (const [key, value] of Object.entries(channel.headers ?? {})) if (typeof value === "string") headers[key] = render(value, vars);
	let body;
	if (method !== "GET" && method !== "HEAD") {
		if (channel.body === void 0) body = JSON.stringify({
			event: payload.event,
			status: payload.status,
			reason: payload.reason,
			title: payload.title,
			text: payload.text,
			...vars
		});
		else if (typeof channel.body === "string") body = render(channel.body, vars, isJson ? "json" : "none");
		else body = JSON.stringify(renderDeep(channel.body, vars));
		if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = contentType;
	}
	return httpRequest(url, {
		method,
		headers,
		body
	}, timeoutMs);
}
//#endregion
//#region src/channels/index.ts
function channelName(channel, index) {
	return channel.name?.trim() || `${channel.type}#${index + 1}`;
}
function sendToChannel(channel, payload, timeoutMs) {
	switch (channel.type) {
		case "bark": return sendBark(channel, payload, timeoutMs);
		case "feishu": return sendFeishu(channel, payload, timeoutMs);
		case "wecom": return sendWecom(channel, payload, timeoutMs);
		case "dingtalk": return sendDingtalk(channel, payload, timeoutMs);
		case "ntfy": return sendNtfy(channel, payload, timeoutMs);
		case "webhook": return sendWebhook(channel, payload, timeoutMs);
		default: return Promise.resolve(localFailure(`未知渠道类型: ${String(channel.type)}`));
	}
}
//#endregion
//#region src/notifier.ts
/**
* pi-agent-push — payload building and dispatch.
*
* Rules that matter:
*  - one attempt per channel, no built-in retry (retry policy stays visible to
*    the user instead of being buried in the plugin);
*  - channels are independent (`Promise.all` over per-channel try/catch), one
*    broken webhook can never block the others;
*  - nothing here ever throws into pi's event loop;
*  - "fire" is non-blocking so the TUI never waits on the network, while
*    `flush()` lets the shutdown path drain in-flight sends before exit.
*/
const LOG_ROTATE_BYTES = 256 * 1024;
function buildPayload(config, input) {
	const now = /* @__PURE__ */ new Date();
	const cwd = input.cwd ?? process.cwd();
	const vars = {
		event: input.event,
		status: input.status,
		reason: input.reason,
		cwd,
		project: basename(cwd) || cwd,
		duration: input.durationMs === void 0 ? "" : formatDuration(input.durationMs),
		session: input.session ?? "",
		model: input.model ?? "",
		host: hostname(),
		time: now.toTimeString().slice(0, 8),
		date: now.toISOString().slice(0, 10)
	};
	const title = render(config.titleTemplate, vars).trim() || "dsh";
	let text = render(config.template, vars).trim() || title;
	if (text.length > config.maxTextChars) text = `${text.slice(0, config.maxTextChars - 1)}…`;
	vars.title = title;
	vars.text = text;
	return {
		event: input.event,
		status: input.status,
		reason: input.reason,
		title,
		text,
		vars
	};
}
function resolveTargets(config, event) {
	const targets = [];
	config.channels.forEach((channel, index) => {
		if (channel.enabled === false) return;
		if (event !== "test") {
			if (!(channel.events?.[event] ?? config.events[event] ?? false)) return;
		}
		targets.push({
			channel,
			name: channelName(channel, index)
		});
	});
	return targets;
}
function writeLog(config, line) {
	const path = logPath();
	try {
		const stat = statSync(path, { throwIfNoEntry: false });
		if (stat && stat.size > LOG_ROTATE_BYTES) renameSync(path, `${path}.1`);
	} catch {}
	try {
		appendFileSync(path, `${(/* @__PURE__ */ new Date()).toISOString()} ${line}\n`, "utf-8");
	} catch {}
}
function capPromise(promise, ms, fallback) {
	return Promise.race([promise, new Promise((resolve) => {
		setTimeout(() => resolve(fallback), ms).unref?.();
	})]);
}
function createNotifier() {
	const inflight = /* @__PURE__ */ new Set();
	let lastKey = "";
	let lastAt = 0;
	let last;
	async function dispatch(config, payload, targets) {
		const results = await Promise.all(targets.map(async ({ channel, name }) => {
			try {
				return toChannelResult(name, await sendToChannel(channel, payload, channel.timeoutMs ?? config.timeoutMs));
			} catch (error) {
				return {
					channel: name,
					ok: false,
					status: 0,
					error: error instanceof Error ? error.message : String(error),
					ms: 0
				};
			}
		}));
		last = {
			at: Date.now(),
			event: payload.event,
			results
		};
		for (const result of results) {
			if (result.ok && !config.debug) continue;
			const verdict = result.ok ? "ok" : "FAIL";
			const detail = result.ok ? `status=${result.status}` : result.error ?? "unknown";
			writeLog(config, `[${payload.event}] ${result.channel} ${verdict} ${detail} (${result.ms}ms)`);
		}
		return results;
	}
	function prepare(config, input, ignoreSwitches) {
		if (!config.enabled) return void 0;
		const targets = resolveTargets(config, ignoreSwitches ? "test" : input.event);
		if (targets.length === 0) return void 0;
		const payload = buildPayload(config, input);
		if (!ignoreSwitches && config.dedupeMs > 0) {
			const key = `${payload.event}|${payload.text}`;
			const now = Date.now();
			if (key === lastKey && now - lastAt < config.dedupeMs) return void 0;
			lastKey = key;
			lastAt = now;
		}
		return {
			payload,
			targets
		};
	}
	function track(promise) {
		const tracked = promise.finally(() => {
			inflight.delete(tracked);
		});
		inflight.add(tracked);
		return tracked;
	}
	return {
		fire(config, input) {
			const prepared = prepare(config, input, false);
			if (!prepared) return;
			track(dispatch(config, prepared.payload, prepared.targets).catch(() => []));
		},
		async fireBlocking(config, input, capMs) {
			const prepared = prepare(config, input, false);
			if (!prepared) return [];
			return capPromise(track(dispatch(config, prepared.payload, prepared.targets).catch(() => [])), capMs, []);
		},
		async sendTest(config, input) {
			const prepared = prepare(config, input, true);
			if (!prepared) return [];
			return track(dispatch(config, prepared.payload, prepared.targets).catch(() => []));
		},
		async flush(capMs) {
			if (inflight.size === 0) return;
			await capPromise(Promise.allSettled([...inflight]).then(() => void 0), capMs, void 0);
		},
		lastResults() {
			return last;
		}
	};
}
//#endregion
//#region src/index.ts
const ERROR_REASON_CHARS = 120;
function describeResults(results) {
	if (results.length === 0) return "没有匹配的渠道";
	return results.map((result) => result.ok ? `${result.channel} ok(${result.status}, ${result.ms}ms)` : `${result.channel} 失败(${result.error ?? "unknown"})`).join("; ");
}
function stringifyError(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (error === void 0 || error === null) return void 0;
	if (typeof error === "object") {
		const message = error.message;
		if (typeof message === "string") return message;
		try {
			return JSON.stringify(error);
		} catch {
			return "未知错误";
		}
	}
	return String(error);
}
function modelLabel(agent) {
	return [agent.options.provider, agent.options.model].filter((part) => typeof part === "string" && part.length > 0).join("/");
}
function payloadContext(agent) {
	return {
		cwd: agent.session.header.cwd ?? process.cwd(),
		session: String(agent.session.id),
		model: modelLabel(agent)
	};
}
function isSubagent(agent) {
	return agent.session.header.origin === "subagent";
}
function activeConfig(agent, runtimeEnabled) {
	if (!runtimeEnabled) return void 0;
	const config = loadConfig();
	if (!config.enabled || !config.exists) return void 0;
	if (agent !== void 0 && isSubagent(agent) && !config.includeSubagents) return void 0;
	return config;
}
function rememberTurnEnd(state, event) {
	if (event.type !== "turn/end") return;
	switch (event.data.reason.kind) {
		case "aborted":
		case "error":
			state.stopKind = event.data.reason.kind;
			state.errorMessage = event.data.reason.kind === "error" ? stringifyError(event.data.reason.error) : void 0;
			break;
		default:
			state.stopKind = void 0;
			state.errorMessage = void 0;
			break;
	}
}
/**
* `agents` is required — every notification is driven by the agent event graph.
* `commands` is optional and requested further down, so headless compositions
* load the listeners without the `/push` command.
*/
const inject = ["agents"];
/** Install dsh-push lifecycle notifications and the optional `/push` command. */
function apply(ctx) {
	const notifier = createNotifier();
	const states = /* @__PURE__ */ new WeakMap();
	const agentsBySession = /* @__PURE__ */ new Map();
	const liveAgents = /* @__PURE__ */ new Set();
	let runtimeEnabled = true;
	const getState = (agent) => {
		const current = states.get(agent);
		if (current !== void 0) return current;
		const created = { startedAt: Date.now() };
		states.set(agent, created);
		return created;
	};
	ctx.on("session/created", () => {
		invalidateConfigCache();
	});
	ctx.on("agent/created", ({ agent }) => {
		agentsBySession.set(agent.session, agent);
		liveAgents.add(agent);
	});
	ctx.on("agent/disposed", ({ agent }) => {
		agentsBySession.delete(agent.session);
		liveAgents.delete(agent);
		states.delete(agent);
	});
	ctx.on("agent/status", ({ agent, status }) => {
		liveAgents.add(agent);
		if (status === "running") {
			states.set(agent, { startedAt: Date.now() });
			return;
		}
		if (status !== "idle") return;
		const state = states.get(agent);
		states.delete(agent);
		if (state === void 0) return;
		const config = activeConfig(agent, runtimeEnabled);
		if (config === void 0) return;
		const durationMs = Math.max(0, Date.now() - state.startedAt);
		if (state.stopKind === "aborted") {
			notifier.fire(config, {
				event: "interrupted",
				status: "已中断",
				reason: "本轮被取消",
				durationMs,
				...payloadContext(agent)
			});
			return;
		}
		if (state.stopKind === "error") {
			notifier.fire(config, {
				event: "interrupted",
				status: "已中断",
				reason: `运行出错：${summarizeError(state.errorMessage, ERROR_REASON_CHARS) || "未知错误"}`,
				durationMs,
				...payloadContext(agent)
			});
			return;
		}
		if (durationMs < config.minDurationSec * 1e3) return;
		notifier.fire(config, {
			event: "idle",
			status: "已就绪",
			reason: "输出结束，等待输入",
			durationMs,
			...payloadContext(agent)
		});
	});
	ctx.on("session/event", (session, event) => {
		if (event.type !== "turn/end") return;
		const agent = agentsBySession.get(session);
		if (agent === void 0) return;
		const state = states.get(agent);
		if (state === void 0) return;
		rememberTurnEnd(state, event);
	});
	ctx.on("agent/error", ({ agent, error }) => {
		const state = getState(agent);
		state.stopKind = "error";
		state.errorMessage = stringifyError(error);
		liveAgents.add(agent);
	});
	ctx.on("tools/execute", (exec, next) => {
		const agent = exec.agent;
		if (agent !== void 0) {
			const config = activeConfig(agent, runtimeEnabled);
			if (config !== void 0 && config.needInputTools.includes(exec.name)) {
				const state = states.get(agent);
				notifier.fire(config, {
					event: "needInput",
					status: "需要确认",
					reason: "dsh 正在等你回答问题",
					durationMs: state === void 0 ? void 0 : Math.max(0, Date.now() - state.startedAt),
					...payloadContext(agent)
				});
			}
		}
		return next();
	});
	ctx.effect(() => async () => {
		const config = loadConfig();
		const timeout = config.shutdownTimeoutMs;
		if (runtimeEnabled && config.enabled && config.exists && config.events.exit) {
			const targets = [...liveAgents].filter((agent) => config.includeSubagents || !isSubagent(agent));
			if (targets.length > 0) await Promise.all(targets.map((agent) => notifier.fireBlocking(config, {
				event: "exit",
				status: "已退出",
				reason: "插件结束",
				...payloadContext(agent)
			}, timeout)));
			else if (liveAgents.size === 0) await notifier.fireBlocking(config, {
				event: "exit",
				status: "已退出",
				reason: "插件结束",
				cwd: process.cwd()
			}, timeout);
		}
		await notifier.flush(timeout);
	}, "dsh-push lifecycle");
	ctx.inject(["commands"], (commandCtx) => {
		return commandCtx.commands.register({
			name: "push",
			description: "dsh-push: status|list|get|set|enable|disable|test|events|on|off|help",
			input: { hint: "[status|list|get|set|enable|disable|test|events|on|off|help]" },
			handler: async ({ agent, rawInput }) => {
				let result;
				try {
					const last = notifier.lastResults();
					result = handlePushCommand(rawInput, {
						runtimeEnabled,
						setRuntimeEnabled: (value) => {
							runtimeEnabled = value;
						},
						last: last === void 0 ? void 0 : {
							at: last.at,
							event: last.event,
							results: last.results
						},
						describeResults
					});
				} catch (error) {
					return {
						kind: "error",
						text: stringifyError(error) ?? "未知错误"
					};
				}
				if (result.runTest) {
					invalidateConfigCache();
					let config = loadConfig();
					if (!config.exists && config.channels.length === 0) return {
						kind: "error",
						text: `未找到配置文件：${config.path}`
					};
					try {
						if (result.testFilter !== void 0) config = filterConfigToChannel(config, result.testFilter);
					} catch (error) {
						return {
							kind: "error",
							text: stringifyError(error) ?? "未知错误"
						};
					}
					const results = await notifier.sendTest({
						...config,
						enabled: true
					}, {
						event: "test",
						status: "测试",
						reason: result.testFilter === void 0 ? "dsh-push 通道测试" : `dsh-push 测试 (${result.testFilter})`,
						durationMs: 0,
						...payloadContext(agent)
					});
					return {
						kind: results.length > 0 && results.every((item) => item.ok) ? "success" : "error",
						text: `dsh-push 测试：${describeResults(results)}`
					};
				}
				return {
					kind: result.ok ? "success" : "error",
					text: result.message
				};
			}
		});
	});
}
//#endregion
export { apply, inject };
