import type { DesktopShortcutsApi, ShortcutConfigSnapshot, ShortcutPlatform } from '../protocol.ts';
/** Browser-profile and origin-local preference key. */
export declare const SHORTCUT_STORAGE_KEY = "dsh.keybindings.v1";
/**
 * Connect localStorage and same-origin external updates to the shared transaction coordinator.
 * @param window - owning browser window.
 * @param platform - visiting device platform.
 * @param publish - accepts complete configuration snapshots.
 * @returns adapter and lifecycle disposal.
 */
export declare function webShortcutStorage(window: Window, platform: ShortcutPlatform, publish: (snapshot: ShortcutConfigSnapshot) => void): DesktopShortcutsApi & {
    dispose(): void;
};
/**
 * Read the origin-scoped preload capability; a missing bridge is an explicit configuration failure.
 * @param window - product window.
 * @returns the restricted Desktop API, or undefined while the preload is unavailable.
 */
export declare function desktopShortcutStorage(window: Window): DesktopShortcutsApi | undefined;
//# sourceMappingURL=storage.d.ts.map