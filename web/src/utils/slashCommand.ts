// 斜杠命令解析(纯函数,供输入框发送前的命令拦截使用;无 DOM 依赖,可单测)。
//
// 成因:系统命令(/compact、/clear、/fork)过去只在「/ 菜单打开且该命令被高亮选中」时才执行。
// 于是下面几种常见操作都会退化成普通消息发给模型:
//   - 手打 `/compact` 直接回车(菜单被点击外部关闭,或末尾多打一个空格使菜单未开启)
//   - `/compact 摘要重点写文件变更` 这类带参数的写法
//   - 手机紧凑布局下用 ➤ 按钮发送(不走菜单键盘分支)
// 退化的结果是「假压缩」:模型收到字符串 "/compact" 后回一句"已为你压缩上下文",前端当场
// 看起来成功,但服务端从未产生 compaction/done 事件、也没有落盘——切换会话重新载入历史,
// 那行压缩标记自然消失。
//
// 规则:仅当**整条输入的第一个词**是已注册命令名时才判定为命令(大小写不敏感,允许 `/`
// 与命令名之间有空格)。这样 `/usr/bin/node`(词里含后续斜杠)、句中的 @引用、未注册的
// `/某技能名` 都不会被误拦——技能仍按原路径交给后端解析注入。

export interface SlashCommandMatch {
  /** 命中的命令名(小写,不含斜杠) */
  name: string;
  /** 命令词之后的剩余文本(已去首尾空白);无参数时为空串 */
  args: string;
}

export function matchSlashCommand(text: string, commandNames: string[]): SlashCommandMatch | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('/')) return null;
  const m = /^\/\s*([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (!commandNames.some((c) => String(c).toLowerCase() === name)) return null;
  return { name, args: (m[2] || '').trim() };
}
