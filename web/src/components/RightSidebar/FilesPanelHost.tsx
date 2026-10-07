// 文件树面板宿主:把 dsh 原版 `FilesBody`(槽位注册体)接到本项目的手搓 props 上。
//
// `FilesBody` 期待 useTabInfo / sessionId / useSessions / useStore / actions / renderSlot / t
// 全部由槽位运行时喂进来。本项目没有移植那层运行时(原因见 dsh-panel-contracts.ts 顶部),
// 所以这里按 docs/plan-files-panel-wiring.md §7 的 (B) 路线自己造:
//
//   - store   : `createFilesStore().create(sid)` —— client-store 的实例是 **React-free** 的
//               (actions / getSnapshot / subscribe),useStore 用 useSyncExternalStore 绑上去;
//   - 数据面  : `filesFace(createList(remote), watch)` —— list 落到本项目的 list_dir / list_local_dir,
//               watch 暂时给「只报一次 ready 就结束」的空流(= 关掉自动刷新,见下方注释);
//   - 文案    : client/locales.ts 的 zh 表(命名空间 sidebarFiles);
//   - 标签    : 由宿主造一条 {id, signal, actions} 记录;openResource 解出绝对路径后回给宿主,
//               宿主再决定「在侧栏打开这个文件」。
//
// 逐字对齐的类型事实见 dsh-panel-contracts.ts 与 docs/handoff-sidebar-remaining.md §3。
import React, { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { shallowEqual } from '@deepseek-ai/dsh-client-store';
import { parseFileAddress, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path';
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import { api } from '../../api';
import type { DirEntry } from '../../types';
import type { RemoteResult, WorkspaceFilesListResult } from '../../dsh-adapters/api-remotes';
import type { WorkspaceDirectoryEntry } from '../../dsh-adapters/api-workspace-files';
import { FilesBody } from '../../dsh/ui-sidebar-files/client/FilesBody.tsx';
import { createList, filesFace, type ListWorkspaceDirectory, type WatchWorkspaceDirectory } from '../../dsh/ui-sidebar-files/client/face.ts';
import { createFilesStore, type FilesState } from '../../dsh/ui-sidebar-files/client/store.ts';
import { zh } from '../../dsh/ui-sidebar-files/client/locales.ts';
import type { PanelTabCommands, PanelTabInfo, UseSessions } from './dsh-panel-contracts';

// ---- 树的 store:句柄模块级一份(标签之间/重新挂载之间共用状态桶),实例按会话切 ----
// dsh 自己是在 apply 里建一个句柄、由框架按会话发实例;这里等价地手工做一次。
const filesStore = createFilesStore();
const filesInstances = new Map<string, ReturnType<typeof filesStore.create>>();
function filesInstance(sid: string): ReturnType<typeof filesStore.create> {
  let instance = filesInstances.get(sid);
  if (instance === undefined) {
    instance = filesStore.create(sid);
    filesInstances.set(sid, instance);
  }
  return instance;
}

/** 本项目的目录条目(FsEntry)→ dsh 树认的 `WorkspaceDirectoryEntry`。 */
function toWorkspaceEntry(parent: string, entry: DirEntry): WorkspaceDirectoryEntry {
  const type: WorkspaceDirectoryEntry['type'] =
    entry.type === 'dir' ? 'directory' : entry.type === 'file' ? 'file' : entry.type === 'link' ? 'symlink' : 'other';
  return {
    name: entry.name,
    path: `${parent.replace(/[/\\]+$/, '')}/${entry.name}`,
    type,
    size: entry.size,
    modifiedAt: entry.mtime,
  };
}

/**
 * 目录变更观察:暂不支持推送。
 *
 * 只吐一帧 `ready` 就结束 —— DirectoryNode 的第一帧 `ready` 会触发首次列举,而流结束后
 * 就再没有事件,等于「只读一次、不自动刷新」。**不能**写「一帧都不吐」:那样 DirectoryNode
 * 的 follow() 一次循环都不进,根目录永远不会被列举。
 */
const watch: WatchWorkspaceDirectory = async function* () {
  yield 'ready';
};

interface Props {
  /** dockkit 给的标签 id(面板按它给自己的树分桶) */
  tabId: TabId;
  /** 当前会话 id;没有会话时为空串(面板显示「没有工作区目录」) */
  sid: string;
  /** 会话工作区根(绝对路径);未知时 undefined */
  cwd: string | undefined;
  /** 工作区在**本机**而不是远端 SSH 主机上:决定 list_local_dir 还是 list_dir */
  local: boolean;
  /** 面板里点开一个文件:宿主决定是走本机链路还是远端链路 */
  onOpenFile: (absolutePath: string) => void;
}

export default function FilesPanelHost({ tabId, sid, cwd, local, onOpenFile }: Props) {
  const instance = filesInstance(sid);

  // 标签记录的生存期:标签正文卸载 = 这条记录没了(面板据此回收状态桶)。
  const abortRef = useRef<AbortController | null>(null);
  if (abortRef.current === null) abortRef.current = new AbortController();
  const signal = abortRef.current.signal;
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // ---- useStore:client-store 的实例订阅面 → React ----
  // 用 useSyncExternalStore 直接绑(实例没有自己的 hook),并缓存选择结果,
  // 免得选择器每次返回新对象时 React 报「getSnapshot should be cached」。
  const useStore = useMemo(() => {
    return function useFilesStore<S>(selector: (state: FilesState) => S, equal: (a: S, b: S) => boolean = shallowEqual): S {
      const cache = useRef<{ value: S } | null>(null);
      const get = (): S => {
        const next = selector(instance.getSnapshot());
        const cached = cache.current;
        if (cached === null || !equal(cached.value, next)) cache.current = { value: next };
        return cache.current.value;
      };
      return useSyncExternalStore(instance.subscribe, get, get);
    };
  }, [instance]);

  // ---- 数据面:目录列举 ----
  const list = useCallback<ListWorkspaceDirectory>(async (_sessionId, path, _signal) => {
    try {
      const result = await api.request(local ? 'list_local_dir' : 'list_dir', { path }, 20000);
      if (_signal.aborted) return { ok: false, error: { code: 'cancelled', message: '已取消' } };
      const entries = ((result?.entries ?? []) as DirEntry[]).map((entry) => toWorkspaceEntry(path, entry));
      const value: WorkspaceFilesListResult = { entries, truncated: false };
      return { ok: true, value } satisfies RemoteResult<WorkspaceFilesListResult>;
    } catch (error) {
      return { ok: false, error: { message: (error as Error).message } };
    }
  }, [local]);

  const inject = useMemo(() => filesFace(list, watch)(sid, instance.actions), [list, sid, instance]);

  // ---- 文案:sidebarFiles 命名空间(zh 表);{name} 占位按 dsh 的模板语法替换 ----
  const t = useCallback<TranslateNS<'sidebarFiles'>>((key, params) => {
    const template = (zh as Record<string, string>)[key] ?? String(key);
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''));
  }, []);

  // ---- useSessions:只暴露当前会话(面板读的是 byId[sessionId]?.cwd) ----
  const sessions = useMemo(() => ({ byId: { [sid]: cwd === undefined ? {} : { cwd } } }), [sid, cwd]);
  const useSessions = useCallback<UseSessions>((selector) => selector(sessions), [sessions]);

  // ---- 标签记录 ----
  // 刷新命令由面板自己 bindCommands 上来(标签菜单/快捷键用);本项目没有那层菜单,
  // 但「重新读取」按钮走的是 face 的 refresh(tabId),所以这里只需接住绑定、不丢引用。
  const refreshCommand = useRef<PanelTabCommands['refresh']>(undefined);

  const openResource = useCallback((address: string) => {
    const parsed = parseFileAddress(address);
    if (parsed === undefined) return;
    // session 作用域给的是**相对工作区**的路径(见 fileAddressFor),这里补回绝对路径。
    onOpenFile(parsed.scope === 'session' ? resolveWorkspacePath(cwd, parsed.path) : parsed.path);
  }, [cwd, onOpenFile]);

  const tab = useMemo<PanelTabInfo>(() => ({
    id: tabId,
    signal,
    refreshShortcut: undefined,
    actions: {
      bindCommands(commands) {
        refreshCommand.current = commands.refresh;
        return () => { if (refreshCommand.current === commands.refresh) refreshCommand.current = undefined; };
      },
      openResource,
      openTab: () => { /* 本项目没有标签类型注册表,忽略 */ },
      close: () => { /* 关闭由 dockkit 的标签条负责 */ },
    },
  }), [tabId, signal, openResource]);

  const useTabInfo = useCallback(() => ({ tab }), [tab]);

  return (
    <FilesBody
      useTabInfo={useTabInfo}
      sessionId={sid}
      useSessions={useSessions}
      useStore={useStore}
      actions={instance.actions}
      {...inject}
      t={t}
      renderSlot={() => null}
    />
  );
}
