/**
 * Manual end-to-end check against a real ntfy server.
 *
 * Unlike `test/run.ts` (hermetic, local HTTP server), this drives whichever
 * build is actually on disk — by default the copy installed into the desktop
 * profile — and then reads the message back from ntfy's own cache, so it also
 * proves the title/priority headers survived the wire.
 *
 *   node test/live-push.ts                     # report only
 *   node test/live-push.ts --expect-title      # fail when the title is dropped
 *
 * Env: DSH_PUSH_LIVE_ENTRY, DSH_PUSH_LIVE_TOPIC, DSH_PUSH_LIVE_SERVER,
 *      DSH_PUSH_LIVE_CONVERSATION.
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ENTRY = process.env.DSH_PUSH_LIVE_ENTRY
	?? "C:/Users/44701/.dsh/profiles/desktop/node_modules/dsh-push/lib/index.js";
const TOPIC = process.env.DSH_PUSH_LIVE_TOPIC ?? "dsh-0810hwyyjhl";
const SERVER = (process.env.DSH_PUSH_LIVE_SERVER ?? "https://ntfy.sh").replace(/\/+$/, "");
const CONVERSATION = process.env.DSH_PUSH_LIVE_CONVERSATION ?? "dsh-push 0.2.0 校验";
const EXPECT_TITLE = process.argv.includes("--expect-title");

const REASON = "输出结束，等待输入";
const STATUS = "已就绪";
const EXPECTED_TITLE = `${CONVERSATION} · ${STATUS}`;

const root = await mkdtemp(join(tmpdir(), "dsh-push-live-"));
const configFile = join(root, "config.json");
process.env.DSH_PUSH_CONFIG = configFile;

await writeFile(configFile, `${JSON.stringify({
	enabled: true,
	timeoutMs: 8000,
	dedupeMs: 0,
	minDurationSec: 0,
	titleTemplate: "{{conversation}} · {{status}}",
	template: "{{reason}}",
	events: { idle: true, interrupted: true, needInput: true, exit: false },
	channels: [{ type: "ntfy", name: "phone", topic: TOPIC, priority: "high" }],
}, null, 2)}\n`);

const startedAtSec = Math.floor(Date.now() / 1000);

// ── minimal cordis stand-in (same contract as test/run.ts) ───────────────────
type Listener = (...args: any[]) => any;
const listeners = new Map<string, Listener[]>();
let registeredCommand: any;

const commandService = {
	register(definition: any): () => void {
		registeredCommand = definition;
		return () => { registeredCommand = undefined; };
	},
};

function fakeContext(services: Record<string, unknown>) {
	const base = {
		...services,
		get(name: string): unknown {
			return services[name];
		},
		on(name: string, listener: Listener): () => boolean {
			const bucket = listeners.get(name) ?? [];
			bucket.push(listener);
			listeners.set(name, bucket);
			return () => true;
		},
		inject(_dependencies: string[], callback: (ctx: any) => unknown): unknown {
			return callback(fakeContext({ ...services, commands: commandService }));
		},
		effect(factory: () => unknown): unknown {
			return factory();
		},
	};
	return base;
}

function emit(name: string, ...args: any[]): void {
	for (const listener of listeners.get(name) ?? []) listener(...args);
}

const sessionTitle = { get: () => ({ title: CONVERSATION }) };
const plugin: any = await import(pathToFileURL(ENTRY).href);
const apply = plugin.apply ?? plugin.default;
assert.equal(typeof apply, "function", `${ENTRY} must export apply`);
apply(fakeContext({ agents: {}, sessionTitle }) as never);

// ── drive one idle transition ────────────────────────────────────────────────
const agent = {
	id: "live-agent",
	options: { provider: "live", model: "check" },
	session: { id: "live-agent", header: { cwd: root }, snapshotEvents: () => [] },
};

emit("agent/created", { agent });
emit("agent/status", { agent, status: "running" });
emit("agent/status", { agent, status: "idle" });

async function statusText(): Promise<string> {
	assert.notEqual(registeredCommand, undefined, "the /push command must be registered");
	const result = await registeredCommand.handler({
		commandId: "live-status",
		agent,
		rawInput: "status",
		signal: new AbortController().signal,
	});
	return String(result.text);
}

let delivered = "";
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
	const text = await statusText();
	const match = /上次推送: .*? → (.+)/.exec(text);
	if (match !== null) {
		delivered = match[1];
		break;
	}
	await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.notEqual(delivered, "", "no push was dispatched within 15s");
console.log(`dispatch: ${delivered}`);
assert.match(delivered, /phone ok\(2\d\d/, `ntfy rejected the push: ${delivered}`);

// ── read the message back from ntfy ─────────────────────────────────────────
async function fetchMessages(): Promise<Array<Record<string, any>>> {
	const response = await fetch(`${SERVER}/${TOPIC}/json?poll=1&since=${startedAtSec}`, {
		signal: AbortSignal.timeout(15_000),
	});
	assert.equal(response.ok, true, `ntfy poll failed with HTTP ${response.status}`);
	const body = await response.text();
	return body
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, any>)
		.filter((item) => item.event === "message");
}

let received: Record<string, any> | undefined;
const pollDeadline = Date.now() + 15_000;
while (received === undefined && Date.now() < pollDeadline) {
	const messages = await fetchMessages();
	received = messages.find((item) => String(item.message ?? "").includes(REASON));
	if (received === undefined) await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.notEqual(received, undefined, `ntfy cache has no message containing "${REASON}"`);

console.log(`received : ${JSON.stringify({ title: received!.title ?? null, message: received!.message, priority: received!.priority, tags: received!.tags ?? null })}`);

const shownTitle = String(received!.title ?? "");
if (EXPECT_TITLE) {
	assert.equal(received!.message, REASON, "body must be the rendered {{reason}}");
	assert.equal(shownTitle, EXPECTED_TITLE, `ntfy must show the rendered title, got ${JSON.stringify(shownTitle)}`);
	assert.equal(Number(received!.priority), 4, "priority=high must arrive as 4");
	console.log("live check passed: title and priority reached the device payload");
} else {
	assert.equal(received!.message, REASON, "body must be the rendered {{reason}}");
	console.log(shownTitle === "" ? "baseline: ntfy stored NO title (title header dropped)" : `baseline: ntfy stored title ${JSON.stringify(shownTitle)}`);
}
