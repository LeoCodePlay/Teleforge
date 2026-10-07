/** Physical-key protocol shared by browser commands and desktop adapters; no DOM or runtime state. */
import type { Branded } from '@deepseek-ai/dsh-brand';
/** Stable command identity owned by the registering feature. */
export type ShortcutCommandId = Branded<'ShortcutCommandId'>;
/** Operating system of the device receiving input. */
export type ShortcutPlatform = 'macos' | 'windows' | 'linux';
/** Application shell selecting the default bindings. */
export type ShortcutRuntime = 'desktop' | 'web';
/** Runtime and operating system selecting one explicit default and preference profile. */
export type ShortcutProfile = `${ShortcutRuntime}:${ShortcutPlatform}`;
/** Logical primary expands to Meta on macOS and Control elsewhere. */
export type ShortcutModifier = 'primary' | 'control' | 'alt' | 'shift' | 'meta';
/** One or two distinct physical keys held together, plus an exact set of modifiers. */
export interface ShortcutBinding {
    readonly code: string;
    readonly secondCode?: string;
    readonly modifiers: readonly ShortcutModifier[];
}
/** Normalized modifier order is also the keycap order. */
export interface NormalizedBinding {
    readonly code: string;
    readonly secondCode?: string;
    readonly modifiers: readonly ('control' | 'alt' | 'shift' | 'meta')[];
}
/**
 * Expand logical modifiers, deduplicate, and validate the physical code.
 * @param binding - declared binding.
 * @param platform - receiving device platform.
 * @returns canonical binding; unsupported codes throw during registration.
 */
export declare function normalizeBinding(binding: ShortcutBinding, platform: ShortcutPlatform): NormalizedBinding;
/**
 * Produce an exact-match index from a normalized binding.
 * @param binding - normalized physical key and modifiers.
 * @returns stable index used for both matching and conflict checks.
 */
export declare function bindingKey(binding: NormalizedBinding): string;
/**
 * Format keycaps and ARIA; Windows separates modifiers with plus signs, while chord keys remain adjacent.
 * @param binding - normalized binding, or null for an unbound command.
 * @param platform - receiving device platform.
 * @returns visible keycaps; two-key chords omit ARIA shortcuts, which only support one non-modifier key.
 */
export declare function presentBinding(binding: NormalizedBinding | null, platform: ShortcutPlatform): {
    keys: readonly string[];
    aria: string | undefined;
};
/**
 * Check Web combinations: Windows and macOS also admit any three or four modifiers; Linux retains the limited set.
 * @param binding - normalized candidate.
 * @param platform - receiving device platform.
 * @returns whether this combination is admitted; admission does not guarantee browser or system delivery.
 */
export declare function isWebBindingAllowed(binding: NormalizedBinding, platform: ShortcutPlatform): boolean;
//# sourceMappingURL=binding.d.ts.map