// @deepseek-ai/dsh-client-ui-sidebar-right/client 的**类型面**适配。
//
// 为什么不直接指向搬进来的 ui-sidebar-right:那是个 cordis 插件包,它的 client/index.ts
// 是注册样板(往容器里塞槽位/i18n/标签类型),会连带 90+ 个与界面无关的类型错误。
// 我们只移植它的**壳体能力**,标签类型注册表由本项目自己实现(见 DockSidebar 的 renderTab),
// 所以这里只提供面板需要的那个类型。
export interface SidebarRightTabDefinition<TKind extends string = string> {
  readonly kind: TKind;
  readonly title: string;
  readonly icon?: unknown;
  readonly multiple?: boolean;
}
