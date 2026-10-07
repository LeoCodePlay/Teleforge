/** Locale preference stored in the Host user-settings document. */
import z from '@deepseek-ai/schemastery';
/** Settings namespace owned by the locale plugin. */
export const LOCALE_SETTINGS_NAMESPACE = 'locale';
/** Field carrying an explicit locale selection; absence delegates to the browser. */
export const LOCALE_PREFERENCE_FIELD = 'preference';
/** Accepted BCP 47-style language ids. */
export const LOCALE_ID_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;
/** Locale identifiers shipped by the browser client. */
export const LOCALE_IDS = ['zh', 'en'];
/** Durable locale schema; also the wire envelope the browser scope validates against. */
export const LocaleSettingsFields = {
    [LOCALE_PREFERENCE_FIELD]: z.string().pattern(LOCALE_ID_PATTERN).required(false),
};
/** Schema for the shared locale preference. */
export const LocaleSettingsSchema = z.object(LocaleSettingsFields);
//# sourceMappingURL=locale-settings.js.map