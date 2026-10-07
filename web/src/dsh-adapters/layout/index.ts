// @deepseek-ai/dsh-client-ui-layout/client 的适配(类型面)。
// dsh 用它把「面板/侧栏归属」告诉槽位渲染器。本项目右栏是自成一体的组件树,
// 不需要这层;保留类型是为了让搬运过来的组件代码原样成立。
import type { ReactNode } from 'react';

export interface RightbarOwnerProps { readonly owner?: string }
export interface ILayout {
  readonly activePanelId: string | null;
  readonly setActivePanel: (id: string | null) => void;
  readonly render?: (node: ReactNode) => ReactNode;
}
