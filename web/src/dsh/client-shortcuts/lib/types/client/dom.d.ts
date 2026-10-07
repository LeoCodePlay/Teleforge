import type { ShortcutFixedInput } from './types.ts';
import type { ShortcutRegistry } from './registry.ts';
import type { ShortcutPlatform, ShortcutRuntime } from '../protocol.ts';
/**
 * Detect the visiting device, never the server operating system.
 * @param document - product document, marked by Electron preload when present.
 * @param navigator - browser device identification.
 * @returns explicit runtime and platform for default resolution.
 */
export declare function detectEnvironment(document: Document, navigator: Navigator): {
    runtime: ShortcutRuntime;
    platform: ShortcutPlatform;
};
/**
 * Install document composition tracking, modal-cache invalidation, and dispatch after local handlers.
 * @param window - input window owned by the client plugin.
 * @param shortcuts - command registry for this window.
 * @param fixed - optional fixed-sequence consumer after local controls.
 * @param native - native input owns configurable bindings; DOM delivery only feeds fixed actions.
 * @returns disposer releasing every listener, the modal observer, and cached nodes.
 */
export declare function installKeyboard(window: Window, shortcuts: Pick<ShortcutRegistry, 'dispatch' | 'runtime' | 'platform'>, fixed?: (input: ShortcutFixedInput) => void, native?: boolean): () => void;
//# sourceMappingURL=dom.d.ts.map