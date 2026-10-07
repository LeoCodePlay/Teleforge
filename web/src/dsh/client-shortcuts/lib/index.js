import z from "@deepseek-ai/schemastery";
//#region lib/types/config.js
/** Window-local timing accepted by the Host and browser keyboard service. */
/** Validated deployment settings for fixed keyboard sequences. */
const Config = z.object({ stopSequenceMs: z.natural().min(1).max(2147483646).default(500) });
//#endregion
//#region lib/types/index.js
/**
* Embed validated keyboard settings in product pages.
* @param ctx - Host context serving browser pages.
* @param config - sequence timing adopted when the page loads.
*/
function apply(ctx, config) {
	ctx.on("webserver/index-inject", (table) => {
		table.push({
			kind: "global",
			name: "__DSH_SHORTCUTS_CONFIG__",
			value: config
		});
	});
}
//#endregion
export { Config, apply };
