/** Internal React bindings for renderer hosts and standard-source scopes. */
import { type ReactNode } from 'react';
import type { HostObservable, KeyedStandardSource, MaybeSnapshotSelectorHook, SlotRendererHost, SnapshotSelectorHook, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots';
/** In-package renderer host context. */
export declare const HostContext: import("react").Context<SlotRendererHost | null>;
/**
 * Read the installed renderer host.
 * @returns the host API.
 */
export declare function useHost(): SlotRendererHost;
/**
 * Read the root standard-source binding.
 * @returns the current root binding.
 */
export declare function useRootBinding(): StandardSourceBinding;
/**
 * Read the current-session-optional binding.
 * @returns a binding whose key is absent when no Session is selected.
 */
export declare function useScopeBinding(): StandardSourceBinding;
/**
 * Publish one resolved scope binding to a renderer subtree.
 * @param props - provider inputs.
 * @param props.binding - binding exposed to scoped entries.
 * @param props.children - subtree that inherits the binding.
 * @returns the scoped React provider.
 */
export declare function ScopeBindingProvider({ binding, children }: {
    binding: StandardSourceBinding;
    children: ReactNode;
}): ReactNode;
/**
 * Bind one observable source to an identity-stable selector Hook.
 * @param source - observable source.
 * @returns cached selector Hook.
 */
export declare function observableHook<T>(source: HostObservable<T>): SnapshotSelectorHook<T>;
/**
 * Bind an optional source without changing Hook call order.
 * @param source - current source, or absence.
 * @returns selector Hook returning `undefined` while absent.
 */
export declare function maybeObservableHook<T>(source: HostObservable<T> | undefined): MaybeSnapshotSelectorHook<T>;
/** Erased open-key selector Hook synthesized from one keyed source family. */
export type KeyedSnapshotHook = (keyOrSelector: string | ((value: unknown) => unknown), selectorOrEqual?: ((value: unknown) => unknown) | ((left: unknown, right: unknown) => boolean), equal?: (left: unknown, right: unknown) => boolean) => unknown;
/**
 * Bind an open-key source family.
 * @param source - keyed resolver, or absence for an optional scope.
 * @returns cached keyed selector Hook.
 */
export declare function keyedObservableHook(source: KeyedStandardSource | undefined, defaultKey?: string): KeyedSnapshotHook;
/** Subscribe the tree to the atomically assembled root standard-source roster. */
export declare function RootStandardProvider({ children }: {
    children: ReactNode;
}): import("react").JSX.Element;
/** Subscribe to the scope roster before resolving and binding its current adapter. */
export declare function ScopeProvider({ scope, children, }: {
    scope: 'session' | 'session-maybe';
    children: ReactNode;
}): import("react").JSX.Element;
//# sourceMappingURL=bindings.d.ts.map