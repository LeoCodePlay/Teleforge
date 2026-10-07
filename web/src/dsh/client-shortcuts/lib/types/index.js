export { Config } from "./config.js";
/**
 * Embed validated keyboard settings in product pages.
 * @param ctx - Host context serving browser pages.
 * @param config - sequence timing adopted when the page loads.
 */
export function apply(ctx, config) {
    ctx.on('webserver/index-inject', (table) => {
        table.push({ kind: 'global', name: '__DSH_SHORTCUTS_CONFIG__', value: config });
    });
}
/* jscpd:ignore-end */
//# sourceMappingURL=index.js.map