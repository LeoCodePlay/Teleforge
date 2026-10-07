/**
 * The follower key of one absolute path.
 * @param path - an absolute path from a Host stat or change frame.
 * @returns the path with `\\` normalized to `/`.
 */
function keyOf(path) {
    return path.replace(/\\/g, '/');
}
/** Notices of one follower, delivered in order and pulled by its consumer. */
class Follower {
    leave;
    pending = [];
    started = Promise.withResolvers();
    wake;
    ended = false;
    hostKey;
    /**
     * Resolves true after the Host acknowledges its subscription, or false if
     * this follower ends before acknowledgement.
     */
    ready = this.started.promise;
    /**
     * @param leave - unregisters this follower and its abort listener.
     */
    constructor(leave) {
        this.leave = leave;
    }
    /**
     * Select the Host path for queued and future changes.
     * @param absolutePath - the successful stat's absolute path.
     */
    bind(absolutePath) {
        this.hostKey = keyOf(absolutePath);
    }
    /** The Host acknowledged an active subscription and resolved workspace root. */
    start() {
        this.started.resolve(true);
    }
    /**
     * Queue one notice.
     * @param notice - what the consumer receives next.
     * @param key - normalized Host path for the change.
     */
    push(notice, key) {
        this.pending.push({ key, notice });
        this.wake?.();
    }
    /** Deliver what is queued, then finish. */
    end() {
        this.ended = true;
        this.started.resolve(false);
        this.wake?.();
    }
    /** Unregister even when the consumer has not started pulling notices. */
    dispose() {
        this.leave();
    }
    /** @inheritdoc */
    async *[Symbol.asyncIterator]() {
        try {
            while (true) {
                const next = this.pending.shift();
                if (next !== undefined) {
                    if (next.notice.kind === 'refresh' || this.hostKey === undefined || next.key === this.hostKey)
                        yield next.notice;
                    continue;
                }
                if (this.ended)
                    return;
                await new Promise((resolve) => { this.wake = resolve; });
                this.wake = undefined;
            }
        }
        finally {
            this.dispose();
        }
    }
}
/** The stream and followers of one Session and requested path. */
class SessionFeed {
    onClose;
    followers = new Set();
    stream;
    closed = false;
    started = false;
    acknowledged = false;
    /**
     * @param remote - the Remote face carrying `workspaceFiles.changes`.
     * @param sessionId - the Session whose filesystem this feed observes.
     * @param path - target path submitted to the Host.
     * @param after - the previous feed of this target still closing, if any; the stream opens once it has settled.
     * @param onClose - called once when the stream is gone, whatever the cause, with the dispose that is closing it.
     */
    constructor(remote, sessionId, path, after, onClose) {
        this.onClose = onClose;
        this.stream = remote.$stream({
            name: `workspace file changes of ${sessionId}`,
            // A predecessor still closing finishes first, so one target never has
            // two Host streams open at once.
            open: (signal) => {
                this.started = false;
                return openAfter(after, () => remote.workspaceFiles.changes(sessionId, path, signal));
            },
            // A normal end means the Host closed the target's feed.
            ended: () => new Error(`workspace file changes of ${sessionId} ended`),
        });
        void this.pump();
    }
    /**
     * Register one resource address before its Host path is known.
     * @param follower - receives changes and binds its path after stat.
     */
    add(follower) {
        this.followers.add(follower);
        if (this.started)
            follower.start();
    }
    /**
     * Unregister one follower; the last one leaving disposes the stream.
     * @param follower - the follower to drop.
     */
    remove(follower) {
        this.followers.delete(follower);
        if (this.followers.size === 0)
            this.close();
    }
    async pump() {
        try {
            for await (const item of this.stream) {
                const frame = item.value;
                switch (frame.kind) {
                    case 'ready':
                        item.accept();
                        this.started = true;
                        for (const follower of this.followers) {
                            follower.start();
                            if (this.acknowledged)
                                follower.push({ kind: 'refresh' }, '');
                        }
                        this.acknowledged = true;
                        break;
                    case 'change': {
                        const key = keyOf(frame.change.absolutePath);
                        const notice = editOf(frame.change);
                        for (const follower of this.followers)
                            follower.push(notice, key);
                        break;
                    }
                    default:
                        assertNever(frame);
                }
            }
        }
        catch {
            // A terminal stream failure or the Host's end: followers end quietly
            // below, and the metadata they hold stays the last known.
        }
        finally {
            this.close();
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        const closed = this.stream.dispose();
        for (const follower of this.followers)
            follower.end();
        this.followers.clear();
        this.onClose(closed);
    }
}
/**
 * Open a Host stream once a predecessor has finished closing.
 * @param after - the predecessor's dispose, or nothing to wait for.
 * @param open - opens the stream.
 * @returns the stream's items.
 */
async function* openAfter(after, open) {
    await after;
    yield* open();
}
/**
 * The write one Host frame reports.
 * @param frame - the Host frame.
 * @returns the edit notice followers receive.
 */
function editOf(frame) {
    return 'absent' in frame ? { kind: 'absent' } : { kind: 'changed', version: frame.version };
}
function assertNever(frame) {
    throw new Error(`Unexpected workspace file watch frame: ${JSON.stringify(frame)}`);
}
/**
 * Per-target sharing of the Host's workspace file change streams.
 *
 * Owned by the provider; one instance serves every session of the Client.
 */
export class ChangeFeed {
    remote;
    /** Live feeds only: a feed removes itself when its stream closes. */
    sessions = new Map();
    /** Streams still closing, by Session and path; a successor waits for its predecessor. */
    closing = new Map();
    /**
     * @param remote - the Remote face carrying `$stream` and `workspaceFiles.changes`.
     */
    constructor(remote) {
        this.remote = remote;
    }
    /**
     * Follow one resource in one session before its Host path is known.
     *
     * The follower is registered on call, not on first pull. Changes delivered
     * to this Client are queued while stat is pending. The first follower starts
     * target's local `changes` call. The iterable ends
     * when `signal` aborts or when the target stream is gone; ending it early
     * (`break`, `return`) unregisters the follower as well, and the last follower
     * of a target disposes its stream. Await a true `ready` result before stat
     * so the Host subscription is active, then bind each stat's absolute path. Until binding,
     * any target invalidation can trigger a retry; after binding, only matching queued
     * and live changes pass.
     * @param sessionId - the Session providing the file's read authority.
     * @param path - requested file path; followers share a stream only for the same Session and path.
     * @param signal - ends the follow.
     * @returns a single-consumer subscription with Host-path binding and explicit disposal.
     */
    follow(sessionId, path, signal) {
        const feed = signal.aborted ? undefined : this.feedOf(sessionId, path);
        const leave = () => {
            signal.removeEventListener('abort', leave);
            follower.end();
            feed?.remove(follower);
        };
        const follower = new Follower(leave);
        if (feed === undefined) {
            follower.end();
        }
        else {
            feed.add(follower);
            signal.addEventListener('abort', leave, { once: true });
        }
        return follower;
    }
    /**
     * Wait for every stream that is still closing, so an owner tearing down
     * leaves no Host stream behind.
     * @returns resolves once no stream of this feed is closing.
     */
    async settle() {
        await Promise.all(this.closing.values());
    }
    feedOf(sessionId, path) {
        const key = JSON.stringify([sessionId, path]);
        const existing = this.sessions.get(key);
        if (existing !== undefined)
            return existing;
        const feed = new SessionFeed(this.remote, sessionId, path, this.closing.get(key), (closed) => {
            this.sessions.delete(key);
            // A dispose that rejects is still a settled close: nothing remains to wait for.
            const tracked = closed.then(() => undefined, () => undefined).then(() => {
                if (this.closing.get(key) === tracked)
                    this.closing.delete(key);
            });
            this.closing.set(key, tracked);
        });
        this.sessions.set(key, feed);
        return feed;
    }
}
//# sourceMappingURL=change-feed.js.map