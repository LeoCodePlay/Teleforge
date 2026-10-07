import type { NormalizedBinding, ShortcutBinding, ShortcutCommandId, ShortcutPlatform, ShortcutProfile, ShortcutRuntime } from './binding.ts';
/** Overrides are platform-local; absent commands inherit defaults and null explicitly unbinds. */
export interface ShortcutDocument {
    readonly schemaVersion: 1 | 2;
    readonly profiles: Readonly<Partial<Record<ShortcutProfile, Readonly<Record<string, ShortcutBinding | null>>>>>;
}
/** Serializable command definitions accepted from the trusted product frame. */
export interface ShortcutDefinition {
    readonly id: ShortcutCommandId;
    readonly defaults: Readonly<Partial<Record<ShortcutProfile, ShortcutBinding>>>;
    /** Fixed actions reserve one or more combinations instead of exposing an editable default. */
    readonly fixed?: readonly [ShortcutBinding, ...ShortcutBinding[]];
}
/** Validation failures select localized copy in the UI. */
export type BindingIssue = 'reserved' | 'unsupported-browser' | 'modifier-required' | 'unsupported-key';
/** A conflicting row keeps its requested binding visible but cannot execute it. */
export interface EffectiveShortcut {
    readonly id: ShortcutCommandId;
    readonly binding: NormalizedBinding | null;
    readonly modified: boolean;
    readonly conflicts: readonly ShortcutCommandId[];
    readonly issue: BindingIssue | null;
}
/** One revision-checked preference edit, limited to the current runtime and platform. */
export type ShortcutEdit = {
    type: 'set';
    id: ShortcutCommandId;
    binding: ShortcutBinding | null;
} | {
    type: 'reset';
    id: ShortcutCommandId;
} | {
    type: 'reset-all';
};
/**
 * Validate JSON binding fields before normalization; unknown fields are rejected to prevent lossy rewrites.
 * @param value - file or IPC input.
 * @returns a binding with a supported physical code, or null for explicit removal.
 */
export declare function parseBinding(value: unknown): ShortcutBinding | null;
/**
 * Decode the complete document while preserving dormant command overrides.
 * @param raw - stored JSON, or null for a missing document.
 * @returns the accepted document or a classified read failure.
 */
export declare function parseShortcutDocument(raw: string | null): ShortcutDocument | 'invalid' | 'future';
/**
 * Check system, editor, and browser reservations using expanded physical modifiers.
 * @param binding - normalized candidate.
 * @param runtime - receiving application shell.
 * @param platform - receiving device.
 * @returns the rejection reason, or null when this combination is allowed.
 */
export declare function bindingIssue(binding: NormalizedBinding, runtime: ShortcutRuntime, platform: ShortcutPlatform): BindingIssue | null;
/**
 * Select the command owner's explicit default for one device profile.
 * @param definition - command identity and per-profile defaults.
 * @param runtime - receiving shell.
 * @param platform - receiving device.
 * @returns the declared physical binding, or undefined for an unbound action.
 */
export declare function resolveShortcutDefault(definition: ShortcutDefinition, runtime: ShortcutRuntime, platform: ShortcutPlatform): ShortcutBinding | undefined;
/**
 * Resolve overrides and conflicts independently of registration order. Explicit overrides displace defaults.
 * @param definitions - active commands.
 * @param document - accepted preferences.
 * @param runtime - receiving shell.
 * @param platform - receiving device.
 * @returns every active command, including unavailable conflicting bindings.
 */
export declare function effectiveShortcuts(definitions: readonly ShortcutDefinition[], document: ShortcutDocument, runtime: ShortcutRuntime, platform: ShortcutPlatform): readonly EffectiveShortcut[];
/**
 * Detect identical combinations or a single key contained in a two-key chord.
 * @param left - normalized candidate.
 * @param right - normalized occupied binding.
 * @returns whether both bindings require the same modifiers and overlap.
 */
export declare function overlappingBindings(left: NormalizedBinding, right: NormalizedBinding): boolean;
/**
 * Apply an edit without modifying other profiles or dormant overrides.
 * @param document - accepted document.
 * @param edit - validated operation.
 * @param runtime - current shell.
 * @param platform - current device.
 * @returns the candidate document, pending conflict checks and durable storage.
 */
export declare function editShortcutDocument(document: ShortcutDocument, edit: ShortcutEdit, runtime: ShortcutRuntime, platform: ShortcutPlatform): ShortcutDocument;
/**
 * Validate a preference edit at the Desktop IPC boundary.
 * @param value - untrusted renderer request.
 * @returns the constrained operation; malformed requests throw.
 */
export declare function parseShortcutEdit(value: unknown): ShortcutEdit;
/**
 * Validate the trusted product's serializable command catalog at IPC ingress.
 * @param value - renderer-supplied active command definitions.
 * @returns validated definitions; duplicate IDs, overlapping defaults, and unsupported combinations throw.
 */
export declare function parseShortcutDefinitions(value: unknown): readonly ShortcutDefinition[];
//# sourceMappingURL=configuration.d.ts.map