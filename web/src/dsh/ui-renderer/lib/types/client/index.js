/**
 * Browser UI renderer. It installs the slot renderer after its Cordis
 * dependencies activate and exposes the mount operation used by the web boot
 * kernel after the complete client roster settles.
 */
import { createElement, useLayoutEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { createSlotRenderer } from "./scoped-slots.js";
import { buildRenderApp } from "./app.js";
import { SlotRegistry } from "./registry.js";
export { SlotRegistry } from "./registry.js";
/** Services required before application assembly. */
export const inject = [];
/** Hydrate the kernel-owned loading DOM before replacing it with the application. */
function BootHandoff(props) {
    const [ready, setReady] = useState(false);
    useLayoutEffect(() => { setReady(true); }, []);
    if (ready)
        return props.app();
    return createElement('div', {
        className: props.boot.className,
        'data-dsh-boot': '',
        dangerouslySetInnerHTML: { __html: props.boot.html },
    });
}
/** Mount React while preserving the framework-free boot DOM through hydration. */
function mountApp(container, app) {
    const boot = container.querySelector(':scope > [data-dsh-boot]');
    if (boot !== null) {
        return hydrateRoot(container, createElement(BootHandoff, {
            app,
            boot: { className: boot.className, html: boot.innerHTML },
        }));
    }
    const root = createRoot(container);
    flushSync(() => { root.render(app()); });
    return root;
}
/**
 * Install the slot renderer and provide the application mount face.
 * @param ctx - Plugin context.
 */
export function apply(ctx) {
    const slots = new SlotRegistry(ctx);
    slots.install(createSlotRenderer());
    ctx.reflect.provide('uiRenderer', {
        mount: (container) => {
            const root = mountApp(container, buildRenderApp({ ctx }));
            return () => { root.unmount(); };
        },
    });
}
//# sourceMappingURL=index.js.map