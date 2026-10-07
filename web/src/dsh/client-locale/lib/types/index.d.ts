import type { Volatile, Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export { LOCALE_IDS, LOCALE_PREFERENCE_FIELD, LOCALE_SETTINGS_NAMESPACE, type BuiltInLocaleId, type LocaleId, type LocaleSettings, } from './locale-settings.ts';
/** Runtime preferences projected to the browser. */
export interface Config {
    /** Explicit locale; omission follows the browser. */
    preference: Volatile<string | undefined>;
}
/** Live preferences projected to the browser. */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    preference: z<string, string, "volatile">;
}>>, Schemastery.ObjectT<NoInfer<{
    preference: z<string, string, "volatile">;
}>>, "plain">;
/** Host preferences are consumed through the configuration form projection.
 * @param ctx Plugin context used for optional settings presentation.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map