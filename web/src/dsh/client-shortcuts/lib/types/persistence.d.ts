import type { Branded } from '@deepseek-ai/dsh-brand';
import type { BindingIssue, ShortcutDefinition, ShortcutDocument, ShortcutEdit } from './configuration.ts';
import type { ShortcutCommandId, ShortcutPlatform, ShortcutRuntime } from './binding.ts';
/** Opaque accepted-state identity, invalidated by configuration and catalog changes. */
export type ShortcutRevision = Branded<'ShortcutRevision'>;
/** Read state retains the last accepted document on failure; loading does not enable commands. */
export interface ShortcutConfigSnapshot {
    readonly revision: ShortcutRevision;
    /** Monotonic within one storage-owner lifetime; clients discard out-of-order IPC replies. */
    readonly sequence: number;
    readonly document: ShortcutDocument;
    readonly status: 'loading' | 'ready' | 'unreadable';
    readonly error: 'read' | 'invalid' | 'future' | null;
    readonly usingDefaults: boolean;
}
/** Save failures never replace effective preferences. */
export interface ShortcutSaveResult {
    readonly status: 'saved' | 'stale' | 'unreadable' | 'write-failed' | 'not-ready' | 'conflict';
    readonly snapshot: ShortcutConfigSnapshot;
    readonly issue?: BindingIssue;
    readonly conflicts?: readonly ShortcutCommandId[];
}
/** Storage adapter owns path/origin isolation and complete replacement on successful writes. */
export interface ShortcutStorage {
    read(): string | null | Promise<string | null>;
    write(raw: string): void | Promise<void>;
}
/** Restricted Desktop preload API; file paths and accelerators never cross from Renderer. */
export interface DesktopShortcutsApi {
    get(definitions: readonly ShortcutDefinition[]): Promise<ShortcutConfigSnapshot>;
    edit(edit: ShortcutEdit, revision: ShortcutRevision): Promise<ShortcutSaveResult>;
    subscribe(listener: (snapshot: ShortcutConfigSnapshot) => void): () => void;
    recording(active: boolean): Promise<void>;
}
/**
 * Create a disabled initial snapshot for asynchronous adapter startup.
 * @returns a fresh configuration with no accepted persisted state.
 */
export declare function initialShortcutConfig(): ShortcutConfigSnapshot;
/** Single-writer coordinator shared by localStorage and Electron's atomic file adapter. */
export declare class ShortcutPersistence {
    private readonly storage;
    private readonly runtime;
    private readonly platform;
    private readonly rereadBeforeWrite;
    private readonly publish;
    private snapshot;
    private raw;
    private queue;
    private definitions;
    private active;
    constructor(storage: ShortcutStorage, runtime: ShortcutRuntime, platform: ShortcutPlatform, rereadBeforeWrite: boolean, publish: (snapshot: ShortcutConfigSnapshot) => void);
    /**
     * Install or revoke a product catalog and invalidate drafts from its previous lifetime.
     * @param definitions - current trusted definitions, or null while the product is not ready.
     */
    setDefinitions(definitions: readonly ShortcutDefinition[] | null): void;
    /** Stop accepting edits or publishing late completions. */
    dispose(): void;
    /**
     * Read the current file; failures retain the last accepted document and disable ordinary writes.
     * @returns the accepted snapshot or diagnostic snapshot.
     */
    readCurrent(): Promise<ShortcutConfigSnapshot>;
    /**
     * Compare the draft revision, validate the complete candidate, then persist before publishing.
     * @param edit - constrained preference operation.
     * @param revision - state against which the user reviewed the edit.
     * @returns a classified outcome and the currently accepted snapshot.
     */
    edit(edit: ShortcutEdit, revision: ShortcutRevision): Promise<ShortcutSaveResult>;
    private serialize;
    private accept;
    private read;
}
//# sourceMappingURL=persistence.d.ts.map