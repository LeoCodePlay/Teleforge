// @deepseek-ai/dsh-client-ui-theme/client 的适配(类型面,只取终端要的那一项)。
//
// 搬进来的 `ui-sidebar-terminal/client/terminal.tsx` 只从它 import `ThemeSnapshot`,并且**只用它做
// 重新取色的依赖项** —— 真正的颜色是 `getComputedStyle(xterm 容器)` 读出来的(见 terminal.tsx 的
// 第二个 useLayoutEffect)。所以这里给一份与 dsh 原件字段同名的结构声明就够,不需要整套主题系统。
//
// 逐字来源:dsh `packages/client/ui-theme/src/client/index.ts`(`ThemeSnapshot` / `ThemeDefinition`)。
// 主题 token 的具体形状本适配不需要,故收敛为 `Record<string, unknown>`。
/** 一个可选主题:id、明暗语义、以及别名 token 覆盖。 */
export interface ThemeDefinition {
  readonly id: string;
  /** 这套主题建在哪套基础调色板上(dsh 用它切 `body[data-ds-dark-theme]`,不看 id)。 */
  readonly colorScheme: 'light' | 'dark';
  /** 以 inline CSS 变量形式叠加的别名层覆盖。 */
  readonly tokens: Record<string, unknown>;
}

/** 主题快照:每次变化都会发布一份新的。 */
export interface ThemeSnapshot {
  /** 持久化的偏好(可能是 `system`)。 */
  readonly preference: string;
  /** 对话正文字号(px)。 */
  readonly fontSize: number;
  /** 解析后的当前主题(override 层已折叠进来,并按当前明暗取好值)。 */
  readonly active: ThemeDefinition;
  /** 已注册主题,注册顺序。 */
  readonly themes: readonly ThemeDefinition[];
  /** 单调递增的变化计数(注册表或当前主题变化都会推它)。 */
  readonly revision: number;
}
