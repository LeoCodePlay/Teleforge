/** Main-document keyboard adapter; local controls arbitrate before window bubbling. */
import { modalSelector, observeComposition } from '@deepseek-ai/dsh-client-ui-primitives';
/**
 * Detect the visiting device, never the server operating system.
 * @param document - product document, marked by Electron preload when present.
 * @param navigator - browser device identification.
 * @returns explicit runtime and platform for default resolution.
 */
export function detectEnvironment(document, navigator) {
    const desktop = document.documentElement.dataset.platform;
    const device = desktop ?? navigator.platform;
    return { runtime: desktop === undefined ? 'web' : 'desktop',
        platform: /darwin|mac|iphone|ipad/iu.test(device) ? 'macos' : /win/iu.test(device) ? 'windows' : 'linux' };
}
/**
 * Install document composition tracking, modal-cache invalidation, and dispatch after local handlers.
 * @param window - input window owned by the client plugin.
 * @param shortcuts - command registry for this window.
 * @param fixed - optional fixed-sequence consumer after local controls.
 * @param native - native input owns configurable bindings; DOM delivery only feeds fixed actions.
 * @returns disposer releasing every listener, the modal observer, and cached nodes.
 */
export function installKeyboard(window, shortcuts, fixed, native = false) {
    const document = window.document;
    const composition = observeComposition(document);
    let pending = false;
    let pendingTimer;
    const reset = () => { fixed?.({ type: 'reset' }); };
    let deadKey = false;
    let dialogs;
    const blur = () => { deadKey = false; reset(); };
    const containsModal = (node) => node instanceof Element
        && (node.matches(modalSelector) || node.querySelector(modalSelector) !== null);
    const changedModals = (records) => {
        if (records.length > 0)
            dialogs = undefined;
        if (records.some(record => record.type === 'attributes'
            ? record.oldValue === 'dialog' || record.oldValue === 'true' || containsModal(record.target)
            : [...record.addedNodes, ...record.removedNodes].some(containsModal)))
            reset();
    };
    const observer = new MutationObserver(changedModals);
    observer.observe(document.documentElement, { childList: true, subtree: true,
        attributes: true, attributeFilter: ['role', 'aria-modal'], attributeOldValue: true });
    const capture = () => {
        if (pending)
            reset();
        window.clearTimeout(pendingTimer);
        changedModals(observer.takeRecords());
        pending = true;
        // Native event listeners can yield a microtask checkpoint before bubbling.
        pendingTimer = window.setTimeout(() => {
            pending = false;
            pendingTimer = undefined;
            reset();
        }, 0);
    };
    const keydown = (event) => {
        window.clearTimeout(pendingTimer);
        pendingTimer = undefined;
        pending = false;
        const target = event.composedPath().find(value => value instanceof Element);
        const element = target instanceof Element ? target : document.activeElement;
        const region = element?.closest('.xterm') ? 'terminal'
            : element?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') ? 'editable' : 'page';
        // Local handlers can change modals before MutationObserver delivers its records.
        changedModals(observer.takeRecords());
        dialogs ??= document.querySelectorAll(modalSelector);
        const top = dialogs[dialogs.length - 1];
        const context = { region, modal: top === undefined ? null : top.dataset.shortcutModal ?? 'other', target: element };
        const guarded = composition.guards(event) || deadKey
            || event.getModifierState('AltGraph');
        const isDead = event.key === 'Dead';
        // macOS can report Option+Command+N as Dead outside input-method composition.
        const commandDeadKey = isDead && shortcuts.runtime === 'web' && shortcuts.platform === 'macos'
            && event.code === 'KeyN' && event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey;
        deadKey = isDead;
        const gesture = { code: event.code, control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey,
            meta: event.metaKey, repeat: event.repeat, composing: guarded || isDead, defaultPrevented: event.defaultPrevented };
        const consume = () => {
            event.preventDefault();
            if (commandDeadKey)
                deadKey = false;
        };
        fixed?.({ type: 'keydown', gesture, context, consume });
        if (native)
            return;
        shortcuts.dispatch({ ...gesture, composing: guarded || (isDead && !commandDeadKey),
            defaultPrevented: event.defaultPrevented }, context, consume);
    };
    document.addEventListener('compositionstart', reset, true);
    document.addEventListener('compositionend', reset, true);
    document.addEventListener('focusin', reset, true);
    document.addEventListener('pointerdown', reset, true);
    window.addEventListener('keydown', capture, true);
    window.addEventListener('keydown', keydown);
    window.addEventListener('blur', blur);
    return () => {
        pending = false;
        window.clearTimeout(pendingTimer);
        observer.disconnect();
        dialogs = undefined;
        composition.dispose();
        document.removeEventListener('compositionstart', reset, true);
        document.removeEventListener('compositionend', reset, true);
        document.removeEventListener('focusin', reset, true);
        document.removeEventListener('pointerdown', reset, true);
        window.removeEventListener('keydown', capture, true);
        window.removeEventListener('keydown', keydown);
        window.removeEventListener('blur', blur);
    };
}
//# sourceMappingURL=dom.js.map