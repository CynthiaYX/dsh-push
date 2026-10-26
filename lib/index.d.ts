import { Context } from "@deepseek-ai/cordis";

//#region src/index.d.ts
/**
 * `agents` is required — every notification is driven by the agent event graph.
 * `commands` is optional and requested further down, so headless compositions
 * load the listeners without the `/push` command.
 */
declare const inject: string[];
/** Install dsh-push lifecycle notifications and the optional `/push` command. */
declare function apply(ctx: Context): void;
//#endregion
export { apply, inject };