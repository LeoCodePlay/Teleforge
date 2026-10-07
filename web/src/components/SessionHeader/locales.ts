// 会话头部弹层的文案字典 —— 逐条照搬 deepseek-harness 的 `subagent` / `job` 两个命名空间
// (packages/client/ui-subagent/src/client/locales.ts 与 packages/client/ui-jobs/src/client/locales.ts)。
//
// 为什么把两个命名空间放一起:它们只服务同一个宿主组件(SessionHeader),分开两个文件反而
// 让「哪句话属于哪个弹层」变得要跳文件才看得清。键名与 dsh 保持逐字一致,便于对照上游。
//
// dsh 的文案通过 ctx.locale 注入(t(key, params));本项目没有那套 locale 服务,这里用一个
// 极小的插值函数等价实现:{name} 占位替换。未提供的键回落到键名本身(便于发现漏搬)。

/** 用 params 替换 `{name}` 占位符。 */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    (name in params ? String(params[name]) : whole));
}

/** 由中文源字典生成一个 t(key, params) 函数。 */
export function makeT<K extends string>(dict: Record<K, string>) {
  return (key: K, params?: Record<string, string | number>): string => interpolate(dict[key], params);
}

/** `subagent` 命名空间(zh 是键集合的事实源,照搬 dsh 原文)。 */
export const subagentZh = {
  'duration.seconds': '{seconds}秒',
  'duration.minutes': '{minutes}分{seconds}秒',
  'duration.hours': '{hours}小时{minutes}分{seconds}秒',
  'duration.days': '{days}天',
  'duration.daysHours': '{days}天{hours}小时',
  'duration.months': '约{months}个月',
  'duration.monthsDays': '约{months}个月{days}天',
  'duration.years': '约{years}年',
  'duration.yearsMonths': '约{years}年{months}个月',
  'duration.exactDays': '{days}天{hours}小时{minutes}分{seconds}秒',
  'duration.exactTitle': '总活跃耗时：{duration}',
  'tokens.thousand': '{value}K',
  'tokens.million': '{value}M',
  'tokens.total': '{value} tok',
  'loading.label': '正在加载子智能体…',
  'load.error': '无法加载子智能体',
  'retry': '重试',
  'mode.oneShot': '一次性',
  'mode.continuable': '可继续',
  'mode.unknown': '模式未知',
  'readonly.unknown.body': '读取子会话后才能确定是否可继续。',
  'activity.running': '正在运行',
  'activity.completed': '已完成',
  'activity.inactive': '当前未运行',
  'branch.collapse': '收起 {label} 的下级子智能体',
  'branch.expand': '展开 {label} 的下级子智能体',
  'count.total.one': '{count} 个子智能体',
  'count.total.other': '{count} 个子智能体',
  'count.running.one': '{count} 个子智能体，正在运行',
  'count.running.other': '{count} 个子智能体，正在运行',
  'switcher.aria': '切换子智能体：{title}',
  'tree.aria': '子智能体会话',
  'open.sidebar': '在侧边栏打开',
  'open.sidebar.aria': '在侧边栏打开 {label}',
  'sidebar.chat': '聊天',
  'readonly.oneShot.title': '一次性子智能体记录',
  'readonly.title': '此子智能体暂时只读',
  'readonly.oneShot.body': '一次性任务不支持后续消息，可在这里查看完整执行记录。',
  'readonly.body': '父会话当前不在线，重新打开父会话后即可继续发送消息。',
} as const;

export type SubagentKey = keyof typeof subagentZh;
export const tSub = makeT<SubagentKey>(subagentZh);

/** `job` 命名空间(zh 是键集合的事实源,照搬 dsh 原文)。 */
export const jobZh = {
  'count.live.one': '{count} 个后台任务运行中',
  'count.live.other': '{count} 个后台任务运行中',
  'count.idle.one': '{count} 个后台任务',
  'count.idle.other': '{count} 个后台任务',
  'list.aria': '后台任务',
  'section.live': '进行中',
  'section.settledCount': '已结束 {count}',
  'section.clear': '清空',
  'row.expandAria': '展开 {label} 的实时输出',
  'row.collapseAria': '收起 {label} 的实时输出',
  'kill.stop': '停止任务 {label}',
  'kill.confirm': '再次点击确认停止',
  'kill.confirmAction': '确认停止',
  'kill.failed': '停止失败',
  'status.running': '运行中',
  'status.stopping': '正在停止',
  'status.completed': '已完成',
  'status.killed': '已取消',
  'status.failed': '已失败',
  'duration.seconds': '{seconds}秒',
  'duration.minutes': '{minutes}分{seconds}秒',
  'duration.hours': '{hours}小时{minutes}分',
  'duration.title.live': '已运行 {duration}',
  'duration.title.done': '耗时 {duration}',
  'output.gap': '……较早的输出已丢弃……',
  'output.error': '实时输出流中断：{error}',
  'terminal.signal': '信号 {signal}',
  'terminal.exitCode': '退出码 {code}',
  'terminal.noExitCode': '未正常退出',
  'terminal.running': '运行中',
  'terminal.failed': '已失败',
  'terminal.done': '已完成',
  'terminal.copy': '复制',
  'terminal.copied': '已复制',
  'terminal.noOutput': '（无输出）',
  'terminal.collapse': '收起',
  'terminal.collapseAria': '收起输出',
  'terminal.expand': '展开其余 {n} 行',
  'terminal.expandAria': '展开被折叠的 {n} 行输出',
} as const;

export type JobKey = keyof typeof jobZh;
export const tJob = makeT<JobKey>(jobZh);
