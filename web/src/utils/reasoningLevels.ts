// 推理等级(reasoning_effort)的唯一定义处。
//
// 为什么单独一个模块:等级清单被三处共用 —— 模型选择菜单(ModelMenu)、
// AI 配置里的「支持的推理等级」勾选(AiConfigPanel)、以及请求落盘时的等级校验口径。
// 放在组件里会逼着设置面板去 import 一个 UI 组件(顺带把它的样式/上下文拖进来)。
//
// 对齐 dsh 0.2.1-rc 的 `f61d9982f8 feat(models): edit reasoning levels of custom model API models`:
// 每个模型可以只声明**自己支持**的那几档,菜单只列支持的档位;没声明 = 全部支持。
import type { ModelContextConfig } from '../types';

/** 推理等级 → 模型的 reasoning_effort 参数,共 6 档。Off 即关闭思考,无需单独的思考开关。 */
export const REASONING_LEVELS = [
  { id: 'default', label: '默认' },
  { id: 'off', label: '关闭' },
  { id: 'low', label: '低' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '较高' },
  { id: 'max', label: '最高' }
] as const;

export type ReasoningLevelId = (typeof REASONING_LEVELS)[number]['id'];

/** 等级 id 是否合法(请求侧只接受清单里的值,别把任意字符串透传给网关)。 */
export function isReasoningLevelId(value: unknown): value is ReasoningLevelId {
  return typeof value === 'string' && REASONING_LEVELS.some((lv) => lv.id === value);
}

/**
 * 某模型实际可选的档位。
 * 未声明(undefined/null/空数组)一律按「全部支持」,并始终保留「默认」——
 * 「默认」表示不传该参数,任何网关都必须能接受,不能因为它被取消勾选就发不出请求。
 */
export function supportedLevels(declared?: readonly string[]): (typeof REASONING_LEVELS)[number][] {
  const ids = Array.isArray(declared) ? declared.filter(isReasoningLevelId) : [];
  if (ids.length === 0) return [...REASONING_LEVELS];
  const set = new Set<string>(ids);
  set.add('default');
  return REASONING_LEVELS.filter((lv) => set.has(lv.id));
}

/** 某模型声明的档位(读取 provider.modelConfig 的便捷入口;取不到视为全部支持)。 */
export function modelSupportedLevels(cfg?: ModelContextConfig): (typeof REASONING_LEVELS)[number][] {
  return supportedLevels(cfg?.reasoningLevels);
}

/** 菜单/设置里展示的简短摘要,例如「全部」「默认·高·最高」。 */
export function levelsSummary(levels: readonly { label: string }[]): string {
  if (levels.length === REASONING_LEVELS.length) return '全部';
  return levels.map((lv) => lv.label).join('·');
}
