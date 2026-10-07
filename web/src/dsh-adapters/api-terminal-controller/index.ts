// @deepseek-ai/dsh-api-terminal-controller 的适配(类型面)。
//
// dsh 的这个包是「终端控制器」:Host 侧持有真实 PTY,Client 侧一个 `TerminalView` 模型负责
// 创建/attach/写输入/resize/收画面。搬进来的 `ui-sidebar-terminal/client/terminal.tsx` 只
// 从它 import **类型**(`TerminalView` / `TerminalViewState`),运行时模型由宿主注入 ——
// 所以这里按 dsh 原件的形状给一份结构等价的声明,真正的实现见
// `components/RightSidebar/TerminalPanelHost.tsx`(接的是本项目既有的 /ws/term shell 通道)。
//
// 类型逐字来源(dsh 仓库):
//   packages/api/terminal-controller/src/types.ts        (品牌 / Shell / Environment / Info / Frame)
//   packages/api/terminal-controller/src/client/model.ts  (终端视图状态与模型公共面)
import type { ObservableSnapshot } from '../../dsh/client-store/src/index.ts';
import type { Branded } from '../brand/index.ts';

/** 终端身份,作用域 = 一个会话 × 一个 Host 生命周期(dsh 原文)。 */
export type WebTerminalId = Branded<'WebTerminalId'>;
/** 允许写输入 / resize 这个终端的 attach 凭据(dsh 原文)。 */
export type TerminalAttachmentId = Branded<'TerminalAttachmentId'>;

/** 一个在 Host 执行环境里验证过的 shell。 */
export interface TerminalShell {
  readonly path: string;
  readonly args: readonly string[];
  readonly name: string;
}

/** 新建与恢复终端共用的工作目录与上限。 */
export interface TerminalEnvironment {
  readonly cwd: string;
  readonly maxInputBytes: number;
  readonly maxCols: number;
  readonly maxRows: number;
  readonly scrollback: number;
}

/** Host 持有的终端状态;进程退出**不会**自动补一个新 shell。 */
export interface WebTerminalInfo {
  readonly id: WebTerminalId;
  readonly title: string;
  readonly shell: TerminalShell;
  /** 初始工作目录;shell 里 cd 不会改这个字段。 */
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly state: 'running' | 'exited' | 'failed';
  readonly exitCode: number | null;
  readonly error?: string;
  readonly controllerId?: TerminalAttachmentId;
}

/** 一次 attach 总是先给一屏完整画面,再给有序输出。 */
export type TerminalFrame =
  | { readonly type: 'snapshot'; readonly sequence: number; readonly screen: string; readonly info: WebTerminalInfo }
  | { readonly type: 'output'; readonly sequence: number; readonly data: string }
  | { readonly type: 'state'; readonly info: WebTerminalInfo };

/** 等 DOM 终端回调确认的一帧画面。 */
export interface TerminalRenderFrame {
  readonly revision: number;
  readonly frame: Extract<TerminalFrame, { type: 'snapshot' | 'output' }>;
}

/** 终端 UI 负责翻译的产品级错误标识。 */
export type TerminalViewIssue = 'missingTerminal' | 'inputFull' | 'attachmentEnded' | 'invalidOutput' | 'terminalLimit';

/** 一条侧栏标签的终端视图状态(dsh 原件的 `TerminalViewState`)。 */
export interface TerminalViewState {
  readonly phase: 'idle' | 'loading' | 'creating' | 'connecting' | 'connected' | 'disconnected' | 'closing' | 'closed' | 'failed';
  readonly environment?: TerminalEnvironment | undefined;
  readonly title?: string | undefined;
  readonly info?: WebTerminalInfo | undefined;
  readonly writable: boolean;
  readonly render?: TerminalRenderFrame | undefined;
  readonly error?: string | undefined;
  readonly issue?: TerminalViewIssue | undefined;
}

/**
 * dsh 原件里 `TerminalView` 是个 class;这里只取面板真正用到的**公共面**做结构类型
 * (terminal.tsx 只用 mount/refresh/connect/acknowledge/write/resize + `state`)。
 * 视图在 DOM 卸载后仍然存活 —— 进程只在显式 close 时结束,所以这里没有自动销毁入口。
 */
export interface TerminalView {
  readonly id: WebTerminalId;
  readonly state: ObservableSnapshot<TerminalViewState>;
  /** 确保连接已经建立;返回的 disposer 只解除本次 mount 的关注,不杀进程。 */
  mount(): () => void;
  /** 重新读一次环境 / 重连。 */
  refresh(): Promise<void>;
  /** 断线后重新接管输入。 */
  connect(): void;
  /** 确认某一帧画面已写进 DOM 终端(流控用)。 */
  acknowledge(revision: number): void;
  /** 键盘输入上行。 */
  write(data: string): void;
  /** 终端尺寸变化上行。 */
  resize(cols: number, rows: number): void;
}
