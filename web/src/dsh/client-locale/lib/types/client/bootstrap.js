/** Locale initialization supplied by a native shell before its Client tree mounts. */
/**
 * Validate initialization data returned over the preload IPC bridge.
 * @param value - untrusted IPC response.
 * @returns language initialization with no persistence side effects.
 */
export function parseLocaleBootstrap(value) {
    if (typeof value !== 'object' || value === null || !('languages' in value) || !Array.isArray(value.languages)
        || !value.languages.every((language) => typeof language === 'string')
        || !('preference' in value) || (value.preference !== null && typeof value.preference !== 'string')) {
        throw new TypeError('locale: invalid native initialization data');
    }
    return { languages: value.languages, preference: value.preference };
}
//# sourceMappingURL=bootstrap.js.map