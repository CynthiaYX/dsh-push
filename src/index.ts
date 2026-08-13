import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { ToolDispatchExecution } from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-commands";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-tools";
import { handlePushCommand, filterConfigToChannel } from "./command.ts";
import { invalidateConfigCache, loadConfig } from "./config.ts";
import { createNotifier, type Notifier, type PayloadInput } from "./notifier.ts";
import { summarizeError } from "./render.ts";
import type { ChannelResult, NotifyConfig } from "./types.ts";

interface RunState {
	startedAt: number;
	stopKind?: "aborted" | "error";
	errorMessage?: string;
}

const ERROR_REASON_CHARS = 120;

function describeResults(results: ChannelResult[]): string {
	if (results.length === 0) return "没有匹配的渠道";
	return results
		.map((result) =>
			result.ok
				? `${result.channel} ok(${result.status}, ${result.ms}ms)`
				: `${result.channel} 失败(${result.error ?? "unknown"})`,
		)
		.join("; ");
}

function stringifyError(error: unknown): string | undefined {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (error === undefined || error === null) return undefined;
	if (typeof error === "object") {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") return message;
		try {
			return JSON.stringify(error);
		} catch {
			return "未知错误";
		}
	}
	return String(error);
}

function modelLabel(agent: Agent): string {
	const provider = agent.options.provider;
	const model = agent.options.model;
	return [provider, model].filter((part): part is string => typeof part === "string" && part.length > 0).join("/");
}

function payloadContext(agent: Agent): Pick<PayloadInput, "cwd" | "session" | "model"> {
	return {
		cwd: agent.session.header.cwd ?? process.cwd(),
		session: String(agent.session.id),
		model: modelLabel(agent),
	};
}

function isSubagent(agent: Agent): boolean {
	return agent.session.header.origin === "subagent";
}

function activeConfig(agent: Agent | undefined, runtimeEnabled: boolean): NotifyConfig | undefined {
	if (!runtimeEnabled) return undefined;
	const config = loadConfig();
	if (!config.enabled || !config.exists) return undefined;
	if (agent !== undefined && isSubagent(agent) && !config.includeSubagents) return undefined;
	return config;
}

function rememberTurnEnd(state: RunState, event: SessionEvent): void {
	if (event.type !== "turn/end") return;
	switch (event.data.reason.kind) {
		case "aborted":
		case "error":
			state.stopKind = event.data.reason.kind;
			state.errorMessage = event.data.reason.kind === "error"
				? stringifyError(event.data.reason.error)
				: undefined;
			break;
		default:
			state.stopKind = undefined;
			state.errorMessage = undefined;
			break;
	}
}

/** Install dsh-push lifecycle notifications and the optional `/push` command. */
export function apply(ctx: Context): void {
	if ((ctx as unknown as { agents?: unknown }).agents === undefined) {
		throw new Error("dsh-push requires the dsh-agent event graph");
	}

	const notifier: Notifier = createNotifier();
	const states = new WeakMap<Agent, RunState>();
	const agentsBySession = new Map<Session, Agent>();
	const liveAgents = new Set<Agent>();
	let runtimeEnabled = true;

	const getState = (agent: Agent): RunState => {
		const current = states.get(agent);
		if (current !== undefined) return current;
		const created: RunState = { startedAt: Date.now() };
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
		if (state === undefined) return;

		const config = activeConfig(agent, runtimeEnabled);
		if (config === undefined) return;
		const durationMs = Math.max(0, Date.now() - state.startedAt);
		if (state.stopKind === "aborted") {
			notifier.fire(config, {
				event: "interrupted",
				status: "已中断",
				reason: "本轮被取消",
				durationMs,
				...payloadContext(agent),
			});
			return;
		}
		if (state.stopKind === "error") {
			notifier.fire(config, {
				event: "interrupted",
				status: "已中断",
				reason: `运行出错：${summarizeError(state.errorMessage, ERROR_REASON_CHARS) || "未知错误"}`,
				durationMs,
				...payloadContext(agent),
			});
			return;
		}
		if (durationMs < config.minDurationSec * 1000) return;
		notifier.fire(config, {
			event: "idle",
			status: "已就绪",
			reason: "输出结束，等待输入",
			durationMs,
			...payloadContext(agent),
		});
	});

	ctx.on("session/event", (session, event) => {
		if (event.type !== "turn/end") return;
		const agent = agentsBySession.get(session);
		if (agent === undefined) return;
		const state = states.get(agent);
		if (state === undefined) return;
		rememberTurnEnd(state, event);
	});

	ctx.on("agent/error", ({ agent, error }) => {
		const state = getState(agent);
		state.stopKind = "error";
		state.errorMessage = stringifyError(error);
		liveAgents.add(agent);
	});

	ctx.on("tools/execute", (exec: ToolDispatchExecution, next) => {
		const agent = exec.agent;
		if (agent !== undefined) {
			const config = activeConfig(agent, runtimeEnabled);
			if (config !== undefined && config.needInputTools.includes(exec.name)) {
				const state = states.get(agent);
				notifier.fire(config, {
					event: "needInput",
					status: "需要确认",
					reason: "dsh 正在等你回答问题",
					durationMs: state === undefined ? undefined : Math.max(0, Date.now() - state.startedAt),
					...payloadContext(agent),
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
			if (targets.length > 0) {
				await Promise.all(targets.map((agent) => notifier.fireBlocking(config, {
					event: "exit",
					status: "已退出",
					reason: "插件结束",
					...payloadContext(agent),
				}, timeout)));
			} else if (liveAgents.size === 0) {
				await notifier.fireBlocking(config, {
					event: "exit",
					status: "已退出",
					reason: "插件结束",
					cwd: process.cwd(),
				}, timeout);
			}
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
						setRuntimeEnabled: (value) => { runtimeEnabled = value; },
						last: last === undefined ? undefined : { at: last.at, event: last.event, results: last.results },
						describeResults,
					});
				} catch (error) {
					return { kind: "error", text: stringifyError(error) ?? "未知错误" };
				}

				if (result.runTest) {
					invalidateConfigCache();
					let config = loadConfig();
					if (!config.exists && config.channels.length === 0) {
						return { kind: "error", text: `未找到配置文件：${config.path}` };
					}
					try {
						if (result.testFilter !== undefined) config = filterConfigToChannel(config, result.testFilter);
					} catch (error) {
						return { kind: "error", text: stringifyError(error) ?? "未知错误" };
					}
					const results = await notifier.sendTest(
						{ ...config, enabled: true },
						{
							event: "test",
							status: "测试",
							reason: result.testFilter === undefined
								? "dsh-push 通道测试"
								: `dsh-push 测试 (${result.testFilter})`,
							durationMs: 0,
							...payloadContext(agent),
						},
					);
					const ok = results.length > 0 && results.every((item) => item.ok);
					return { kind: ok ? "success" : "error", text: `dsh-push 测试：${describeResults(results)}` };
				}

				return { kind: result.ok ? "success" : "error", text: result.message };
			},
		});
	});
}

export default apply;
