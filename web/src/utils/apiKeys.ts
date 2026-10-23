// API Key 列表的展示辅助(AI 配置 / 生图配置共用):
// 两个面板的卡片与编辑弹窗必须用同一套「去重口径 / 脱敏口径 / 状态口径」,
// 否则同一个 Key 在 AI 面板显示为 1 个、在生图面板显示为 2 个,排查时只会更乱。
import type { KeyState } from '../types';

/** 该配置的全部 Key(去重、去空);首位为主 Key(apiKey) */
export function keyList(p: { apiKey?: string; apiKeys?: string[] }): string[] {
  return [...new Set([p.apiKey, ...(p.apiKeys || [])].map((k) => String(k || '').trim()).filter(Boolean))] as string[];
}

/** 展示用脱敏:只露头尾,避免整串 Key 出现在界面上 */
export function maskKey(k: string): string {
  return k.length <= 12 ? k : `${k.slice(0, 6)}…${k.slice(-4)}`;
}

/** 状态徽标的悬停说明:两种不可用标记的文案不同,处理方式也不同(充值 vs 换 Key) */
export function keyStateTip(st?: KeyState): string {
  if (st?.reason) return st.reason;
  return st?.invalid ? '该 Key 鉴权失败(无效/过期/被撤销)' : '该 Key 余额不足';
}
