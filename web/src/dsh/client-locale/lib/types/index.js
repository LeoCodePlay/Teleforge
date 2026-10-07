import z from '@deepseek-ai/schemastery';
import { LOCALE_PREFERENCE_FIELD } from "./locale-settings.js";
import { LocaleSettingsFields } from "./locale-settings.js";
export { LOCALE_IDS, LOCALE_PREFERENCE_FIELD, LOCALE_SETTINGS_NAMESPACE, } from "./locale-settings.js";
/** Live preferences projected to the browser. */
export const Config = z.object({
    [LOCALE_PREFERENCE_FIELD]: LocaleSettingsFields[LOCALE_PREFERENCE_FIELD].volatile(),
});
/** Host preferences are consumed through the configuration form projection.
 * @param ctx Plugin context used for optional settings presentation.
 */
export function apply(ctx) {
    ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)); });
}
//# sourceMappingURL=index.js.map