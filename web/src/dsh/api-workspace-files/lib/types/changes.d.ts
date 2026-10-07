/**
 * Target-scoped filesystem watches and `fs/observed` invalidations for `changes`.
 * Each generation sends `ready` after watcher initialization, then reads current
 * target metadata for matching queued and live invalidations.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceFileWatchFrame } from './types.ts';
/** Owns target watches, instrumented observations, and every open `changes` generation. */
export declare class WorkspaceChangeFeed {
    private readonly ctx;
    private readonly followers;
    /** @param ctx - Host context carrying the filesystem the observations come from. */
    constructor(ctx: Context);
    /**
     * Open one target watch; directory targets remain inside `workspaceRoot`.
     * @param workspaceRoot - the session's workspace root path.
     * @param path - target path, resolved relative to the workspace root; Host metadata determines its type.
     * @param signal - generation cancellation.
     * @returns `ready` after watching starts, then current metadata for target invalidations.
     */
    follow(workspaceRoot: string, path: string, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame>;
}
//# sourceMappingURL=changes.d.ts.map