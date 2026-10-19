// 斜杠命令解析(纯函数,供输入框发送前的命令拦截与菜单补全使用;无 DOM 依赖,可单测)。
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
// 规则:仅当**整条输入的第一个词**是已注册命令名(或它的中文 token,如 `/计划`、`/目标`)时
// 才判定为命令(大小写不敏感,允许 `/` 与命令名之间有空格)。这样 `/usr/bin/node`(词里含后续
// 斜杠)、句中的 @引用、未注册的 `/某技能名` 都不会被误拦——技能仍按原路径交给后端解析注入。
//
// 中文 token 的由来:teleforge 是中文产品,deepseek-harness 的 zh 词条把 /plan 显示为「计划」、
// /goal 显示为「目标」,用户也按中文输入(见 harness 的 command-menu-zh 用例)。因此命令可以
// 同时按规范名(plan/goal,服务端与日志用它)与中文 token(计划/目标,输入与菜单用它)命中。

export interface SlashCommandMatch {
  /** 命中的命令名(小写,不含斜杠);可能是中文 token,调用方据此查回命令 */
  name: string;
  /** 命令词之后的剩余文本(已去首尾空白);无参数时为空串 */
  args: string;
}

export function matchSlashCommand(text: string, commandNames: string[]): SlashCommandMatch | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('/')) return null;
  // token 允许中日韩字符:中文 token(/计划、/目标)必须与 ASCII 命令名等价命中
  const m = /^\/\s*([a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff][a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff-]*)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (!commandNames.some((c) => String(c).toLowerCase() === name)) return null;
  return { name, args: (m[2] || '').trim() };
}

/** 转义正则字面量(命令名/技能名里可能有 . - 等字符) */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 菜单里插入一个命令词的结果:text 为插好 token(或原样)的整条输入,caret 为插完后的光标位。 */
export interface SlashTokenInsertion {
  text: string;
  caret: number;
}

/**
 * 在输入里"插入"一个命令词(菜单选中命令时只补全、不执行)。
 *
 * 与 matchSlashCommand 同属斜杠命令的纯逻辑,故放在本模块:输入框组件只负责把它写回 textarea。
 * 规则:
 *  - 吃掉落笔位置前那个已键入的 /词(行首或空白后的 `/目标`、`/co`…),换成规范 token + 尾随空格,
 *    光标停在参数位;`/` 之前的文本原样保留(支持在已有文字后面追加命令);
 *  - token 已完整存在(前有行首/空白、后有空白/结尾)时只移动光标,不重复插入 —— 与技能补全的
 *    "已存在则删除"旧缺陷同源,这里统一按"不重复"处理;
 *  - 非 `/` 结尾的输入原样返回(菜单没开时的误调用不该改写草稿)。
 *
 * @param input 当前整条输入(草稿)
 * @param name 命令规范名(如 goal),与 token 等价
 * @param token 显示/输入用的词(中文 token 如「目标」;缺省用规范名)
 */
export function insertSlashToken(input: string, name: string, token?: string): SlashTokenInsertion {
  const text = String(input ?? '');
  const word = String(token || name);
  const m = /(^|\s)\/[a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff-]*$/i.exec(text);
  if (!m) return { text, caret: text.length };
  const head = text.slice(0, m.index + m[1].length);
  const tail = text.slice(m.index + m[0].length);
  const present = new RegExp(`(?:^|\\s)/(?:${escapeRe(name)}|${escapeRe(word)})(?=\\s|$)`, 'i').test(head);
  const insert = present ? '' : `/${word} `;
  const next = head + insert + tail;
  return { text: next, caret: head.length + insert.length };
}
