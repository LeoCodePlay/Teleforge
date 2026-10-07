/** Shared config references used by schema validators and plugin runtimes. */
const write = Symbol.for('cosmokit.volatile.write');
function snapshot(value, ancestors = new Set()) {
    if (typeof value === 'function')
        throw new TypeError('volatile config cannot contain functions');
    if (value === null || typeof value !== 'object')
        return value;
    if (ancestors.has(value))
        throw new TypeError('volatile config cannot contain cycles');
    ancestors.add(value);
    try {
        if (Array.isArray(value))
            return Object.freeze(value.map(item => snapshot(item, ancestors)));
        if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
            throw new TypeError('volatile config objects must be plain objects or arrays');
        }
        return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, ancestors)])));
    }
    finally {
        ancestors.delete(value);
    }
}
/**
 * Create a detached reference containing an immutable copy of the supplied data.
 * @param value - validated config data; class instances and functions are unsupported.
 * @returns a reference whose value is updated only by its owning runtime.
 */
export function createVolatile(value) {
    let current = snapshot(value);
    return Object.freeze({
        get: () => current,
        [write]: (value) => { current = value; },
    });
}
/**
 * Identify references across ESM/CJS copies of the shared library.
 * @param value - a parsed config value.
 * @returns whether the value implements the shared reference protocol.
 */
export function isVolatile(value) {
    return typeof value === 'object' && value !== null && write in value;
}
/**
 * Collect config references without descending into their snapshots or opaque objects.
 * @internal
 * @param value - parsed config; cyclic ordinary fields are visited once per path.
 * @returns references and their object-key paths, including an empty path for a root reference.
 */
export function volatileEntries(value) {
    const ancestors = new Set();
    function visit(value, path) {
        if (isVolatile(value))
            return [{ path, ref: value }];
        if (!value || typeof value !== 'object' || ancestors.has(value))
            return [];
        if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
            return [];
        ancestors.add(value);
        try {
            return Object.entries(value).flatMap(([key, child]) => visit(child, [...path, key]));
        }
        finally {
            ancestors.delete(value);
        }
    }
    return visit(value, []);
}
/**
 * Commit an already validated immutable snapshot from another reference.
 * @internal
 * @param target - the owning plugin's stable reference.
 * @param source - a newly parsed candidate reference.
 */
export function updateVolatile(target, source) {
    ;
    target[write](source.get());
}
//# sourceMappingURL=volatile.js.map