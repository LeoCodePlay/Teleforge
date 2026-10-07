/** Browser command service, with one keyboard adapter per plugin lifetime. */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type { Shortcuts } from './types.ts';
import type { ShortcutFixedInput } from './types.ts';
export type { ShortcutCatalogEntry, ShortcutCommand, ShortcutContext, ShortcutGesture, Shortcuts } from './types.ts';
export type { ShortcutFixedInput, ShortcutFixedCommand, ShortcutFixedCatalogEntry } from './types.ts';
export type { ShortcutBinding, ShortcutCommandId, ShortcutPlatform, ShortcutRuntime } from '../protocol.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Window-local application commands and effective keycap catalog. */
        shortcuts: Shortcuts;
    }
}
/** Cordis keyboard provider; Desktop startup requires its native keyboard bridge. */
export default class ShortcutsService extends Service implements Shortcuts {
    static inject: string[];
    readonly runtime: Shortcuts['runtime'];
    readonly platform: Shortcuts['platform'];
    readonly catalog: Shortcuts['catalog'];
    readonly config: Shortcuts['config'];
    readonly fixedCatalog: Shortcuts['fixedCatalog'];
    readonly stopSequenceMs: number;
    private readonly fixedListeners;
    private readonly adapter;
    private readonly keyboard;
    private active;
    private connected;
    private readonly registry;
    constructor(ctx: Context);
    register(command: Parameters<Shortcuts['register']>[0]): () => void;
    registerFixed(command: Parameters<Shortcuts['registerFixed']>[0]): () => void;
    observeFixedInput(listener: (input: ShortcutFixedInput) => void): () => void;
    private fixedInput;
    describeBinding(binding: Parameters<Shortcuts['describeBinding']>[0]): ReturnType<Shortcuts['describeBinding']>;
    private syncDefinitions;
    private failRead;
    /**
     * Persist one reviewed operation while retaining accepted bindings on failure.
     * @param args - edit and expected revision supplied by the editor.
     * @returns classified save outcome and accepted snapshot.
     */
    edit(...args: Parameters<Shortcuts['edit']>): ReturnType<Shortcuts['edit']>;
    recording(active: boolean): Promise<void>;
    closeWindow(): Promise<void>;
}
//# sourceMappingURL=index.d.ts.map