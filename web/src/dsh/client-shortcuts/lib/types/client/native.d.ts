import type { DesktopKeyboardApi, ShortcutConfigSnapshot } from '../protocol.ts';
import type { ShortcutRegistry } from './registry.ts';
/**
 * Route native menu, main-frame, and embedded-frame input through the shared command registry.
 * @param window - trusted product document.
 * @param keyboard - top-frame preload capability.
 * @param registry - window-local command owner.
 * @param snapshot - latest accepted configuration.
 * @param reset - clears pending fixed sequences when native input bypasses DOM delivery.
 * @returns disposer releasing native input.
 */
export declare function installNativeKeyboard(window: Window, keyboard: DesktopKeyboardApi, registry: ShortcutRegistry, snapshot: () => ShortcutConfigSnapshot, reset?: () => void): () => void;
//# sourceMappingURL=native.d.ts.map