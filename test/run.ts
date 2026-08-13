import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "dsh-push-test-"));
const configFile = join(root, "config.json");
const requests: string[] = [];

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
	let body = "";
	request.setEncoding("utf8");
	request.on("data", (chunk: string) => { body += chunk; });
	request.on("end", () => {
		requests.push(body);
		response.statusCode = 200;
		response.end("ok");
	});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("test server did not expose an address");
const endpoint = `http://127.0.0.1:${address.port}/push`;
process.env.DSH_PUSH_CONFIG = configFile;

await writeFile(configFile, `${JSON.stringify({
	enabled: true,
	includeSubagents: false,
	timeoutMs: 2000,
	shutdownTimeoutMs: 1000,
	dedupeMs: 0,
	minDurationSec: 0,
	events: { idle: true, interrupted: true, needInput: true, exit: false },
	channels: [{ type: "webhook", name: "local", url: endpoint }],
}, null, 2)}\n`);

const { apply } = await import("../src/index.ts");

type Listener = (...args: any[]) => any;
interface FakeAgent {
	id: string;
	options: { provider: string; model: string };
	session: { id: string; header: { cwd: string; origin?: "subagent" } };
}

let registeredCommand: any;
let lifecycleDisposer: (() => unknown) | undefined;
let commandDisposer: (() => unknown) | undefined;
const listeners = new Map<string, Listener[]>();
const commandService = {
	register(definition: any): () => void {
		registeredCommand = definition;
		const disposer = () => { registeredCommand = undefined; };
		commandDisposer = disposer;
		return disposer;
	},
};
const context = {
	agents: {},
	on(name: string, listener: Listener): () => boolean {
		const bucket = listeners.get(name) ?? [];
		bucket.push(listener);
		listeners.set(name, bucket);
		return () => {
			const current = listeners.get(name) ?? [];
			const index = current.indexOf(listener);
			if (index < 0) return false;
			current.splice(index, 1);
			return true;
		};
	},
	inject(_dependencies: string[], callback: (ctx: any) => unknown): unknown {
		return callback({ commands: commandService });
	},
	effect(factory: () => unknown, label?: string): unknown {
		const result = factory();
		if (typeof result === "function") {
			const disposer = result as () => unknown;
			if (label === "dsh-push lifecycle") lifecycleDisposer = disposer;
			if (label === "dsh-push commands") commandDisposer = disposer;
		}
		return result;
	},
};

apply(context as never);

let noCommandsInjectCalled = false;
apply({
	agents: {},
	on: () => () => true,
	inject: () => {
		noCommandsInjectCalled = true;
		return undefined;
	},
	effect: (factory: () => unknown) => factory(),
} as never);
assert.equal(noCommandsInjectCalled, true, "plugin must request optional commands injection");

function agent(id: string, origin?: "subagent"): FakeAgent {
	return {
		id,
		options: { provider: "provider", model: "model" },
		session: { id, header: { cwd: root, ...(origin === undefined ? {} : { origin }) } },
	};
}

function emit(name: string, ...args: any[]): any[] {
	return (listeners.get(name) ?? []).map((listener) => listener(...args));
}

async function executeTool(agentValue: FakeAgent, name: string): Promise<void> {
	let nextCalls = 0;
	const next = async () => { nextCalls += 1; };
	const continuations = emit("tools/execute", {
		name,
		agent: agentValue,
		signal: new AbortController().signal,
	}, next);
	await Promise.all(continuations);
	assert.equal(nextCalls, 1, `expected next() once for ${name}`);
}

async function waitForRequests(count: number): Promise<void> {
	const deadline = Date.now() + 2000;
	while (requests.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(requests.length >= count, `expected at least ${count} requests, got ${requests.length}`);
}

const rootAgent = agent("root");
emit("agent/created", { agent: rootAgent });
emit("agent/status", { agent: rootAgent, status: "running" });
emit("session/event", rootAgent.session, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
emit("agent/status", { agent: rootAgent, status: "idle" });
await waitForRequests(1);
assert.equal(JSON.parse(requests[0]).event, "idle");

const beforeSecondTurn = requests.length;
emit("agent/status", { agent: rootAgent, status: "running" });
emit("session/event", rootAgent.session, { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } });
assert.equal(requests.length, beforeSecondTurn);
emit("agent/status", { agent: rootAgent, status: "running" });
emit("agent/status", { agent: rootAgent, status: "idle" });
await waitForRequests(beforeSecondTurn + 1);

const beforeInterrupted = requests.length;
emit("agent/status", { agent: rootAgent, status: "running" });
emit("session/event", rootAgent.session, { type: "turn/end", data: { turn: 3, reason: { kind: "aborted", reason: { kind: "user" } } } });
emit("agent/status", { agent: rootAgent, status: "idle" });
await waitForRequests(beforeInterrupted + 1);
assert.equal(JSON.parse(requests.at(-1)!).event, "interrupted");

const beforeError = requests.length;
emit("agent/status", { agent: rootAgent, status: "running" });
emit("agent/error", { agent: rootAgent, error: new Error("boom") });
emit("agent/status", { agent: rootAgent, status: "idle" });
await waitForRequests(beforeError + 1);
assert.equal(JSON.parse(requests.at(-1)!).event, "interrupted");

const beforeNeedInput = requests.length;
await executeTool(rootAgent, "ask_user_question");
await waitForRequests(beforeNeedInput + 1);
assert.equal(JSON.parse(requests.at(-1)!).event, "needInput");
const afterNeedInput = requests.length;
await executeTool(rootAgent, "exit_plan_mode");
await waitForRequests(afterNeedInput + 1);
const afterExitPlan = requests.length;
await executeTool(rootAgent, "bash");
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(requests.length, afterExitPlan);

const subagent = agent("child", "subagent");
emit("agent/created", { agent: subagent });
emit("agent/status", { agent: subagent, status: "running" });
emit("session/event", subagent.session, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
emit("agent/status", { agent: subagent, status: "idle" });
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(requests.length, afterExitPlan);

assert.notEqual(registeredCommand, undefined);
const commandResult = await registeredCommand.handler({
	commandId: "test-command",
	agent: rootAgent,
	rawInput: "test",
	signal: new AbortController().signal,
});
assert.equal(commandResult.kind, "success");
assert.equal(JSON.parse(requests.at(-1)!).event, "test");

await writeFile(configFile, `${JSON.stringify({
	enabled: true,
	includeSubagents: false,
	timeoutMs: 2000,
	shutdownTimeoutMs: 1000,
	events: { idle: true, interrupted: true, needInput: true, exit: true },
	channels: [{ type: "webhook", name: "local", url: endpoint }],
}, null, 2)}\n`);
emit("session/created", rootAgent.session);
const beforeExit = requests.length;
assert.notEqual(lifecycleDisposer, undefined);
await lifecycleDisposer!();
await waitForRequests(beforeExit + 1);
assert.equal(JSON.parse(requests.at(-1)!).event, "exit");
assert.notEqual(commandDisposer, undefined);
await commandDisposer!();
assert.equal(registeredCommand, undefined);

await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
await readFile(configFile);
console.log("dsh-push phase 2 tests passed");
