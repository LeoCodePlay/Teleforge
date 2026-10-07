/** Desktop gestures use live focus, modal state, and verified embedding ownership. */
import { modalSelector } from '@deepseek-ai/dsh-client-ui-primitives';
/**
 * Route native menu, main-frame, and embedded-frame input through the shared command registry.
 * @param window - trusted product document.
 * @param keyboard - top-frame preload capability.
 * @param registry - window-local command owner.
 * @param snapshot - latest accepted configuration.
 * @param reset - clears pending fixed sequences when native input bypasses DOM delivery.
 * @returns disposer releasing native input.
 */
export function installNativeKeyboard(window, keyboard, registry, snapshot, reset) {
    return keyboard.subscribe((input) => {
        if (input.revision !== snapshot().revision)
            return;
        reset?.();
        let target = window.document.activeElement;
        while (target?.shadowRoot?.activeElement != null && !target.matches('webview[data-sidebar-browser-frame]')) {
            target = target.shadowRoot.activeElement;
        }
        const top = [...window.document.querySelectorAll(modalSelector)].at(-1);
        const region = target?.closest('.xterm') ? 'terminal'
            : target?.matches('input, textarea, select, [contenteditable="true"], [contenteditable=""]') ? 'editable' : 'page';
        const context = { target, region, modal: top?.dataset.shortcutModal ?? (top === undefined ? null : 'other') };
        if (input.kind === 'menu') {
            registry.invoke(input.commandId, context);
            return;
        }
        if (input.kind === 'keyboard') {
            registry.dispatch({ ...input, composing: false, defaultPrevented: false }, context, () => { });
            return;
        }
        // Renderer focus and embedding identity may change after preload verification.
        if (input.kind === 'webview') {
            if (target?.matches('webview[data-sidebar-browser-frame]') !== true || !target.isConnected
                || input.frameName === '' || target.getAttribute('name') !== input.frameName)
                return;
            registry.dispatch({ ...input, composing: false, defaultPrevented: false }, { ...context, source: 'webview' }, () => { });
            return;
        }
        if (!(target instanceof HTMLIFrameElement) || !target.isConnected
            || !target.matches('iframe[data-sidebar-browser-frame], iframe[data-html-preview]')
            || input.frameName === '' || target.name !== input.frameName)
            return;
        registry.dispatch({ ...input, composing: false, defaultPrevented: false }, { ...context, source: 'iframe' }, () => { });
    });
}
//# sourceMappingURL=native.js.map