/**
 * Build the assembled application factory.
 * @param deps - Active UI-renderer dependencies.
 * @returns Factory producing the application React tree.
 */
export function buildRenderApp(deps) {
    const { ctx } = deps;
    return () => ctx.slots.renderSlot('root', {});
}
//# sourceMappingURL=app.js.map