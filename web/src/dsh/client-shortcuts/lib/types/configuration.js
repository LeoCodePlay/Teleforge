/** Validated preference documents and deterministic conflict resolution, without browser dependencies. */
import { assertNever } from '@deepseek-ai/dsh-util-values';
import { bindingKey, isWebBindingAllowed, normalizeBinding } from "./binding.js";
const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const commandPattern = /^[a-z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+$/u;
/**
 * Validate JSON binding fields before normalization; unknown fields are rejected to prevent lossy rewrites.
 * @param value - file or IPC input.
 * @returns a binding with a supported physical code, or null for explicit removal.
 */
export function parseBinding(value) {
    if (value === null)
        return null;
    if (!record(value) || Object.keys(value).some(key => key !== 'code' && key !== 'secondCode' && key !== 'modifiers')
        || typeof value.code !== 'string' || !Array.isArray(value.modifiers)
        || (Object.hasOwn(value, 'secondCode') && typeof value.secondCode !== 'string')
        || !value.modifiers.every((modifier) => typeof modifier === 'string' && ['primary', 'control', 'alt', 'shift', 'meta'].includes(modifier))) {
        throw new Error('Invalid shortcut binding');
    }
    const binding = {
        code: value.code, modifiers: value.modifiers,
        ...(typeof value.secondCode === 'string' ? { secondCode: value.secondCode } : {}),
    };
    normalizeBinding(binding, 'windows');
    return binding;
}
/**
 * Decode the complete document while preserving dormant command overrides.
 * @param raw - stored JSON, or null for a missing document.
 * @returns the accepted document or a classified read failure.
 */
export function parseShortcutDocument(raw) {
    if (raw === null)
        return { schemaVersion: 1, profiles: {} };
    try {
        const value = JSON.parse(raw);
        if (!record(value))
            return 'invalid';
        if (typeof value.schemaVersion === 'number' && value.schemaVersion > 2)
            return 'future';
        if ((value.schemaVersion !== 1 && value.schemaVersion !== 2) || !record(value.profiles)
            || Object.keys(value).some(key => key !== 'schemaVersion' && key !== 'profiles'))
            return 'invalid';
        const profiles = {};
        for (const [profile, overrides] of Object.entries(value.profiles)) {
            if (!/^(desktop|web):(macos|windows|linux)$/u.test(profile) || !record(overrides))
                return 'invalid';
            const bindings = {};
            for (const [id, binding] of Object.entries(overrides)) {
                if (!commandPattern.test(id))
                    return 'invalid';
                const parsed = parseBinding(binding);
                if (value.schemaVersion === 1 && parsed?.secondCode !== undefined)
                    return 'invalid';
                bindings[id] = parsed;
            }
            profiles[profile] = bindings;
        }
        return { schemaVersion: value.schemaVersion, profiles };
    }
    catch (_error) {
        // Invalid JSON and invalid binding fields both preserve the original document.
        return 'invalid';
    }
}
/**
 * Check system, editor, and browser reservations using expanded physical modifiers.
 * @param binding - normalized candidate.
 * @param runtime - receiving application shell.
 * @param platform - receiving device.
 * @returns the rejection reason, or null when this combination is allowed.
 */
export function bindingIssue(binding, runtime, platform) {
    const { code, modifiers } = binding;
    if (runtime === 'desktop' && (platform === 'windows' || platform === 'macos'))
        return null;
    if (binding.secondCode !== undefined)
        return 'unsupported-key';
    if (modifiers.length === 0 || modifiers.every(modifier => modifier === 'shift'))
        return 'modifier-required';
    if ((platform === 'windows' || platform === 'macos') && modifiers.length >= 3)
        return null;
    if (runtime === 'web' && (platform === 'windows' || platform === 'macos') && isWebBindingAllowed(binding, platform))
        return null;
    const primary = modifiers.includes(platform === 'macos' ? 'meta' : 'control');
    if (['Escape', 'Tab', 'Space', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)
        || (code === 'Enter' && !modifiers.includes('alt'))
        || (primary && ['KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY', 'KeyQ', 'KeyH'].includes(code))
        || (primary && code === 'KeyA' && !modifiers.includes('shift'))
        || (platform !== 'macos' && (modifiers.includes('meta') || (modifiers.includes('alt') && ['F4', 'F2'].includes(code))))
        || (platform === 'macos' && modifiers.includes('control') && modifiers.includes('meta'))
        || (platform === 'macos' && modifiers.includes('alt') && !primary))
        return 'reserved';
    if (runtime === 'web' && !isWebBindingAllowed(binding, platform))
        return 'unsupported-browser';
    return null;
}
/**
 * Select the command owner's explicit default for one device profile.
 * @param definition - command identity and per-profile defaults.
 * @param runtime - receiving shell.
 * @param platform - receiving device.
 * @returns the declared physical binding, or undefined for an unbound action.
 */
export function resolveShortcutDefault(definition, runtime, platform) {
    return definition.defaults[`${runtime}:${platform}`];
}
/**
 * Resolve overrides and conflicts independently of registration order. Explicit overrides displace defaults.
 * @param definitions - active commands.
 * @param document - accepted preferences.
 * @param runtime - receiving shell.
 * @param platform - receiving device.
 * @returns every active command, including unavailable conflicting bindings.
 */
export function effectiveShortcuts(definitions, document, runtime, platform) {
    const overrides = document.profiles[`${runtime}:${platform}`] ?? {};
    const fixed = definitions.flatMap(row => row.fixed?.map(binding => ({ id: row.id, binding: normalizeBinding(binding, platform) })) ?? []);
    const rows = definitions.filter(row => row.fixed === undefined).map(({ id, defaults }) => {
        const modified = Object.hasOwn(overrides, id);
        const candidate = modified ? overrides[id] : resolveShortcutDefault({ id, defaults }, runtime, platform);
        const binding = candidate == null ? null : normalizeBinding(candidate, platform);
        return { id, binding, modified, issue: binding === null ? null : bindingIssue(binding, runtime, platform) };
    });
    return rows.map((row) => {
        const binding = row.binding;
        return { ...row, conflicts: binding === null ? [] : [...new Set([...rows.filter(other => other.id !== row.id
                        && other.binding !== null && other.issue === null && overlappingBindings(other.binding, binding)
                        && (!row.modified || other.modified)).map(other => other.id),
                    ...fixed.filter(other => overlappingBindings(other.binding, binding)).map(other => other.id)])] };
    });
}
/**
 * Detect identical combinations or a single key contained in a two-key chord.
 * @param left - normalized candidate.
 * @param right - normalized occupied binding.
 * @returns whether both bindings require the same modifiers and overlap.
 */
export function overlappingBindings(left, right) {
    if (left.modifiers.join('+') !== right.modifiers.join('+'))
        return false;
    if (left.secondCode !== undefined && right.secondCode !== undefined)
        return bindingKey(left) === bindingKey(right);
    return [left.code, left.secondCode].some(code => code !== undefined && (code === right.code || code === right.secondCode));
}
/**
 * Apply an edit without modifying other profiles or dormant overrides.
 * @param document - accepted document.
 * @param edit - validated operation.
 * @param runtime - current shell.
 * @param platform - current device.
 * @returns the candidate document, pending conflict checks and durable storage.
 */
export function editShortcutDocument(document, edit, runtime, platform) {
    const schemaVersion = runtime === 'desktop' && (platform === 'macos' || platform === 'windows') ? 2 : document.schemaVersion;
    const profile = `${runtime}:${platform}`;
    let overrides = { ...document.profiles[profile] };
    switch (edit.type) {
        case 'set':
            overrides[edit.id] = edit.binding;
            break;
        case 'reset': {
            const { [edit.id]: _removed, ...remaining } = overrides;
            overrides = remaining;
            break;
        }
        case 'reset-all':
            overrides = {};
            break;
        /* v8 ignore next -- parseShortcutEdit validates this closed union before persistence. */
        default: return assertNever(edit, 'shortcut edit');
    }
    return { schemaVersion, profiles: { ...document.profiles, [profile]: overrides } };
}
/**
 * Validate a preference edit at the Desktop IPC boundary.
 * @param value - untrusted renderer request.
 * @returns the constrained operation; malformed requests throw.
 */
export function parseShortcutEdit(value) {
    if (!record(value))
        throw new Error('Invalid shortcut edit');
    if (value.type === 'reset-all' && Object.keys(value).length === 1)
        return { type: value.type };
    if (typeof value.id !== 'string' || !commandPattern.test(value.id))
        throw new Error('Invalid shortcut command');
    if (value.type === 'reset' && Object.keys(value).length === 2)
        return { type: 'reset', id: value.id };
    if (value.type === 'set' && Object.keys(value).length === 3)
        return { type: 'set', id: value.id, binding: parseBinding(value.binding) };
    throw new Error('Invalid shortcut edit');
}
/**
 * Validate the trusted product's serializable command catalog at IPC ingress.
 * @param value - renderer-supplied active command definitions.
 * @returns validated definitions; duplicate IDs, overlapping defaults, and unsupported combinations throw.
 */
export function parseShortcutDefinitions(value) {
    if (!Array.isArray(value))
        throw new Error('Invalid shortcut catalog');
    const ids = new Set();
    for (const entry of value) {
        if (!record(entry) || typeof entry.id !== 'string' || !commandPattern.test(entry.id) || ids.has(entry.id)
            || !record(entry.defaults) || Object.keys(entry).some(key => key !== 'id' && key !== 'defaults' && key !== 'fixed'))
            throw new Error('Invalid shortcut definition');
        ids.add(entry.id);
        if (Object.hasOwn(entry, 'fixed')) {
            if (!Array.isArray(entry.fixed) || entry.fixed.length === 0 || Object.keys(entry.defaults).length > 0)
                throw new Error('Invalid fixed shortcut definition');
            for (const binding of entry.fixed)
                if (parseBinding(binding) === null)
                    throw new Error('Invalid fixed shortcut binding');
        }
        for (const [profile, candidate] of Object.entries(entry.defaults)) {
            if (!/^(desktop|web):(macos|windows|linux)$/u.test(profile))
                throw new Error('Invalid shortcut profile');
            const binding = parseBinding(candidate);
            if (binding === null)
                throw new Error('Invalid shortcut default');
        }
    }
    const definitions = value;
    for (const runtime of ['desktop', 'web']) {
        for (const platform of ['macos', 'windows', 'linux']) {
            const bindings = [];
            for (const entry of definitions) {
                const binding = resolveShortcutDefault(entry, runtime, platform);
                if (binding === undefined)
                    continue;
                const normalized = normalizeBinding(binding, platform);
                if (bindings.some(other => overlappingBindings(other, normalized))
                    || bindingIssue(normalized, runtime, platform) !== null)
                    throw new Error('Conflicting or reserved shortcut default');
                bindings.push(normalized);
            }
        }
    }
    return definitions;
}
//# sourceMappingURL=configuration.js.map