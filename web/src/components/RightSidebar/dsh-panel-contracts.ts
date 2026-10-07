// dsh 面板(**槽位注册体**)与本项目宿主之间的**类型契约**。
//
// 背景:搬进来的面板组件都用 `PropsRuntime<'sidebar.right.pane.tab'>` 这类「槽位声明」取 props。
// 那张 SlotMap 在 client-ui-slots 里声明为空,由各包自己 `declare module` 增补合并。而声明它的
// `ui-sidebar-right/client/contract/slots.ts` 位于 `web/src/dsh/`(主 tsconfig 明确排除),
// 于是槽位表在本项目的编译程序里是空的 —— 不补声明,面板 props 会整体退化成 never。
//
// 本项目**没有**移植槽位运行时,走的是「手搓宿主 props」路线(见 docs/plan-files-panel-wiring.md
// §7 的 (B))。所以这里只补自己要用到的那几条,并且**不 import 任何注册层入口**
// (ui-sidebar-*/client/index.ts 会把 definition.tsx / 注册样板一起拖进来,已实测 25 错)。
//
// 为什么放 components/ 而不是 dsh-adapters/:tsconfig.dsh.json 同时 include
// `ui-sidebar-right`(它自己声明了同名的 'sidebar.right.pane.tab')与 `dsh-adapters`,
// 放那边会撞成「同名属性类型不一致」。放这里则两侧互不干扰。
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit';

/** 标签正文能挂到标签菜单/快捷键上的操作(dsh `SidebarRightTabCommands`)。 */
export interface PanelTabCommands {
  /** 这份页面的刷新操作;省略表示该页面不提供刷新。 */
  readonly refresh?: () => void;
}

/** 标签对自己的操作(dsh `SidebarRightTabActions`)。 */
export interface PanelTabActions {
  /** 挂上页面操作,返回的 disposer 在正文卸载或标签消失时摘掉它。 */
  bindCommands(commands: PanelTabCommands): () => void;
  /** 打开一个 `dsh-resource://` 资源;本项目把它翻译成「在侧栏打开文件」。 */
  openResource(address: string, options?: unknown): void;
  /** 打开一个页面类型(dsh 的标签注册表能力;本项目不需要,留空实现)。 */
  openTab(kind: string, options?: unknown): void;
  /** 关闭本标签。 */
  close(): void;
}

/**
 * 面板读到的那条标签(dsh `SidebarRightTabInfo['tab']` 的子集):
 * 只列本项目真的会喂进去、面板也真的会读的成员。
 */
export interface PanelTabInfo {
  readonly id: TabId;
  /** 标签记录的生存期;中止即表示这条标签没了(面板据此忘掉自己的状态桶)。 */
  readonly signal: AbortSignal;
  /** 这条标签正文当前是不是「可见的」(dsh 用它决定要不要 fit / focus / 轮询)。 */
  readonly visible: boolean;
  /** 「重新读取」按钮上挂的快捷键提示;本项目不注册快捷键,故为 undefined。 */
  readonly refreshShortcut?: { readonly keys?: readonly string[]; readonly aria?: string } | undefined;
  readonly actions: PanelTabActions;
}

/** dsh 槽位注入面里的 `tabInfo`:**返回 hook 的工厂**(SlotHookFactory 的形状)。 */
export type UsePanelTabInfo = () => { readonly tab: PanelTabInfo };
export type PanelTabInfoHookFactory = (standard: unknown, hookContext: unknown) => UsePanelTabInfo;

/** 会话表:面板只读 `byId[sessionId]?.cwd`(工作区根)。 */
export interface PanelSessionInfo {
  readonly cwd?: string | undefined;
}
export interface PanelSessionsState {
  readonly byId: Readonly<Record<string, PanelSessionInfo | undefined>>;
}

/**
 * dsh 的 `useSessions` 选择器 hook。dsh 里由 ui-session 合并进 GlobalStandardProps;
 * 本项目直接由宿主给一个「只喂当前会话」的实现。
 */
export type UseSessions = <S>(
  selector: (state: PanelSessionsState) => S,
  equal?: (left: S, right: S) => boolean,
) => S;

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * 一条标签的正文,按标签类型的 id 派发。本项目没有标签注册表,面板由
     * DockSidebar 的 renderBody 按 kind 分派 —— 这里保留槽位声明只是为了让
     * `PropsRuntime<'sidebar.right.pane.tab'>` 能推出 `useTabInfo` / `sessionId` / `useSessions`。
     */
    'sidebar.right.pane.tab': {
      kind: 'keyed';
      scope: 'session';
      hookContext: unknown;
      inject: { hooks: { tabInfo: PanelTabInfoHookFactory } };
    };
    /** 文件树头部(重新读取按钮之后)的动作槽;本项目不注册条目,renderSlot 给空实现。 */
    'sidebar.right.tab.files.actions': {
      kind: 'list';
      scope: 'session';
      owner: {
        /** 文件树当前显示的绝对目录路径。 */
        readonly absolutePath: string;
      };
    };
  }

  /** dsh 里由 ui-session 合并;本项目由宿主直接提供。 */
  interface SessionStandardProps {
    readonly sessionId: string;
  }

  /** dsh 里由 ui-session 合并;本项目由宿主直接提供。 */
  interface GlobalStandardProps {
    readonly useSessions: UseSessions;
  }
}
