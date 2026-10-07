import type { ShortcutCommandId, ShortcutConfigSnapshot, ShortcutDefinition, ShortcutPlatform, ShortcutRuntime } from '../protocol.ts';
import type { ShortcutCatalogEntry, ShortcutCommand, ShortcutContext, ShortcutGesture, ShortcutFixedCommand, ShortcutFixedCatalogEntry } from './types.ts';
/** Dispatch consumption is independent of later business-operation success. */
type ShortcutDispatch = {
    status: 'handled';
    commandId: ShortcutCommandId;
} | {
    status: 'blocked';
    commandId: ShortcutCommandId;
    reason: string;
} | {
    status: 'pass';
};
/** Application command registry; adapters own event listeners, feature plugins own actions. */
export declare class ShortcutRegistry {
    readonly runtime: ShortcutRuntime;
    readonly platform: ShortcutPlatform;
    private readonly commands;
    private readonly fixedCommands;
    private readonly conflicts;
    private readonly bindings;
    private readonly state;
    /** Effective localized rows derived from the accepted configuration. */
    readonly catalog: {
        getSnapshot: () => readonly ShortcutCatalogEntry[];
        subscribe: (listener: () => void) => () => void;
    };
    /** Accepted preferences and visible read diagnostics. */
    readonly config: {
        getSnapshot: () => ShortcutConfigSnapshot;
        subscribe: (listener: () => void) => () => void;
    };
    /** Fixed local operations whose owning plugins are mounted. */
    readonly fixedCatalog: import("@deepseek-ai/dsh-client-store").SnapshotStore<readonly ShortcutFixedCatalogEntry[]>;
    constructor(runtime: ShortcutRuntime, platform: ShortcutPlatform, config?: ShortcutConfigSnapshot);
    /**
     * Return the serializable active catalog for storage validation.
     * @returns definitions without callbacks or localized labels.
     */
    definitions(): readonly ShortcutDefinition[];
    /**
     * Register a read-only input action whose keys cannot be assigned to editable commands.
     * @param command - owner-localized action and readable sequence.
     * @returns idempotent disposer removing its reference row.
     */
    registerFixed(command: ShortcutFixedCommand): () => void;
    private refreshFixedLabels;
    /**
     * Publish accepted preferences and all derived labels atomically.
     * @param config - storage owner's latest accepted snapshot.
     */
    configure(config: ShortcutConfigSnapshot): void;
    /**
     * Register atomically after checking defaults for all supported platforms and shells.
     * @param command - feature-owned command definition.
     * @returns idempotent disposer removing both matching and catalog entries.
     */
    register(command: ShortcutCommand): () => void;
    /**
     * Recompute effective bindings when preferences, commands, or locale change.
     * @param config - accepted configuration, defaulting to the current snapshot.
     */
    refreshLabels(config?: ShortcutConfigSnapshot): void;
    /**
     * Invoke a native menu selection independently of its optional key binding.
     * @param id - registered product command.
     * @param context - live input owner and modal state.
     */
    invoke(id: ShortcutCommandId, context: ShortcutContext): void;
    /**
     * Windows/macOS Desktop bindings override local regions and modal controls independently of their configuration source.
     * @param gesture - normalized DOM/native input facts.
     * @param context - synchronous input and modal owner.
     * @param consume - adapter's preventDefault, called before business execution.
     * @returns handled, blocked with a reason, or pass for local/system input.
     */
    dispatch(gesture: ShortcutGesture, context: ShortcutContext, consume: () => void): ShortcutDispatch;
}
export {};
//# sourceMappingURL=registry.d.ts.map