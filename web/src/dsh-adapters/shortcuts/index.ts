// @deepseek-ai/dsh-client-shortcuts 的适配:快捷键的类型面。
// 运行时绑定由 App 自己的键盘处理负责(不引入 dsh 的快捷键服务),
// 所以这里只提供类型;侧栏用它标注「分屏/关闭的按键提示」。
export type ShortcutCommandId = string;
export interface ShortcutBinding {
  readonly id: ShortcutCommandId;
  readonly keys: readonly string[];
  readonly when?: string;
}
export interface ShortcutCatalogEntry {
  readonly id: ShortcutCommandId;
  readonly keys: readonly string[];
  readonly label?: string;
  /** 无障碍说明:侧栏把快捷键提示挂到 aria-label 上时用 */
  readonly aria?: string;
}
export type Shortcuts = {
  readonly catalog: readonly ShortcutCatalogEntry[];
  readonly binding: (id: ShortcutCommandId) => ShortcutBinding | undefined;
};
