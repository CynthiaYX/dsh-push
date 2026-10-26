import { Context } from "@deepseek-ai/cordis";

//#region src/index.d.ts
/** Install dsh-push lifecycle notifications and the optional `/push` command. */
declare function apply(ctx: Context): void;
//#endregion
export { apply, apply as default };