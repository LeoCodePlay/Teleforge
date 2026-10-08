// 对话统计的两个胶囊(照搬 deepseek-harness 的 StatsPills),铺在对话面板最底一行:
//   ⟨秒表⟩ 1 轮 88 步 · 243 tok/s      ⟨数据仓⟩ 13.2M tok · 缓存命中 98%
// 设计要点(每条都有理由,改前先读):
//  - **始终占位显示**:两个胶囊从会话一开始就渲染(一步没跑显示 `0 轮 0 步`,
//    没有计费显示 `0 tok`)—— 统计行的高度恒定,首批统计到齐时不会把输入区
//    与对话区顶上去,否则会看到页面抖动。零数据时退化为**不可点的纯文本**,
//    不会因为一个全是 0 的弹层而噪声更大。
//  - **没有该项数据时连行都不显示**(而不是显示 0):旧会话没有 firstTokenTime,
//    于是"首 token 延迟/速度"两行不出现;网关不报 cacheWrite,"缓存写入"行不出现。
//  - **速度用解码时长**:decodeTokens / decodeMs,且服务端保证分子分母同源;
//    若用"整步耗时"会把等待工具的时间算进去,得出人为偏低的 tok/s。
//  - 弹层用 createPortal:定位坐标按锚点实测后 fixed 到视口,免得被祖先的
//    overflow/transform 裁剪(与 PermissionSelect 同因)。
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionStatsInfo, TokenUsageTotals } from '../../types';
import { IconDatabase16, IconStopwatch16 } from '../icons/icons';
import {
  formatCacheHitPercent, formatDuration, formatExactTokens, formatTokens, formatTokensPerSecond
} from './tokenFormat';
import './StatsPills.scss';

interface Props {
  usage: TokenUsageTotals | null;
  stats: SessionStatsInfo | null;
}

/** 计费输入 = 三个输入桶之和(缓存命中率的分母) */
export function billedInput(usage: TokenUsageTotals): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** 缓存命中率文本;没有可计输入时为 null(UI 不显示该项) */
export function cacheHitText(usage: TokenUsageTotals): string | null {
  return formatCacheHitPercent(usage.cacheReadTokens, billedInput(usage));
}

/** 解码速度(tok/s);没有解码时长时返回 null */
function decodeSpeed(stats: SessionStatsInfo): string | null {
  if (!(stats.decodeMs > 0)) return null;
  return formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000));
}

/** 一个可点开的统计胶囊:点击在锚点旁弹出明细 */
function Pill({ id, icon, label, title, ariaLabel, children }: {
  id: string;
  /** 前导图标(项目的 16 号线性图标;统计行传 12 号尺寸) */
  icon: React.ReactNode;
  label: React.ReactNode;
  title: string;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // 弹层坐标(fixed + portal 到 body):优先贴在锚点上方(统计行就在面板最底部,
  // 上方是对话区,弹出不遮住正在看的内容);只有上方确实放不下(窗口很矮/锚点很高)
  // 才翻到锚点下方。水平方向按视口夹取,右边不够时左移,明细不会溢出屏幕。
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 打开时量一次锚点与面板尺寸,随窗口变化重测
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const a = rootRef.current?.getBoundingClientRect();
      if (!a) return;
      const p = panelRef.current?.getBoundingClientRect();
      const panelW = p?.width || 0;
      const panelH = p?.height || 0;
      const GAP = 6, EDGE = 8;
      const left = Math.max(EDGE, Math.min(a.left, window.innerWidth - panelW - EDGE));
      // 上方可用高度够(含 8px 边界)就在上方;此时 bottom = 视口高 - 锚点顶 + 间距
      const fitsAbove = a.top - GAP - panelH >= EDGE;
      setPos(fitsAbove
        ? { left, bottom: window.innerHeight - a.top + GAP }
        : { left, top: a.bottom + GAP });
    };
    place();
    // 第二帧再测:首帧面板刚挂上,量不到真实宽高(夹取与翻转都要它)
    const raf = requestAnimationFrame(place);
    window.addEventListener('resize', place);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', place); };
  }, [open]);

  // Escape / 点击外部关闭(与项目内其他弹层一致)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onDown, true); };
  }, [open]);

  return (
    <span ref={rootRef} className="stat-pill-anchor" data-stat={id}>
      <button type="button" className="stat-pill" aria-haspopup="dialog" aria-expanded={open}
        aria-label={ariaLabel} data-tip={ariaLabel} onClick={() => setOpen((v) => !v)}>
        <span className="stat-pill-icon" aria-hidden>{icon}</span>
        <span className="stat-pill-label">{label}</span>
      </button>
      {open && createPortal(
        <div ref={panelRef} className="stat-dialog" role="dialog" aria-label={title}
          style={pos
            ? { left: pos.left, ...(pos.top !== undefined ? { top: pos.top } : { bottom: pos.bottom }) }
            : { left: -9999, bottom: 0 }}>
          <div className="stat-dialog-title">{title}</div>
          {children}
        </div>,
        document.body
      )}
    </span>
  );
}

/** 明细里的一行;值为 null 时整行不渲染(与 dsh 的"缺该项就不显示该行"一致) */
function Row({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (<><dt>{label}</dt><dd>{value}</dd></>);
}

/**
 * 活动胶囊:轮/步 + 解码速度;展开为模型耗时 / 工具耗时 / 首 token 延迟 / 速度。
 * 一步都没跑完时显示 `0 轮 0 步` 占位(不是不渲染:统计行高度必须恒定)。
 * 窗口内一个计时数据都没有时退化为**纯文本**(不弹一个空明细)。
 */
export function ActivityPill({ stats }: { stats: SessionStatsInfo }) {
  const speed = decodeSpeed(stats);
  const counts = `${stats.turns} 轮 ${stats.steps} 步`;
  const label = speed === null ? counts : <>{counts}<span className="stat-sep" aria-hidden>·</span>{speed}</>;
  const hasDetail = stats.llmMs > 0 || stats.toolMs > 0 || stats.ttftSteps > 0 || speed !== null;
  const aria = speed === null ? counts : `${counts} · ${speed}`;
  if (!hasDetail) {
    return (
      <span className="stat-pill-anchor" data-stat="activity">
        <span className="stat-pill static"><span className="stat-pill-icon" aria-hidden><IconStopwatch16 size={12} /></span>
          <span className="stat-pill-label">{label}</span></span>
      </span>
    );
  }
  return (
    <Pill id="activity" icon={<IconStopwatch16 size={12} />} label={label} title="对话统计" ariaLabel={aria}>
      <dl className="stat-dialog-details" data-session-stats-details>
        <Row label="模型耗时" value={stats.llmMs > 0 ? formatDuration(stats.llmMs) : null} />
        {/* 口径说明写进标签:工具是并行执行的,这是各次耗时之和,不是墙钟等待 */}
        <Row label="工具耗时(合计)" value={stats.toolMs > 0 ? formatDuration(stats.toolMs) : null} />
        <Row label="首 token 延迟(平均)"
          value={stats.ttftSteps > 0 ? formatDuration(stats.ttftMs / stats.ttftSteps) : null} />
        <Row label="解码速度" value={speed} />
      </dl>
    </Pill>
  );
}

/** 用量胶囊:总量 + 缓存命中率;展开为命中率/输入/缓存读/缓存写/输出 */
export function UsagePill({ usage }: { usage: TokenUsageTotals }) {
  const billed = billedInput(usage);
  const hit = cacheHitText(usage);
  const hitLabel = hit === null ? null : `缓存命中 ${hit}%`;
  const total = formatTokens(billed + usage.outputTokens);
  const label = hitLabel === null ? `${total} tok`
    : <>{total} tok<span className="stat-sep" aria-hidden>·</span>{hitLabel}</>;
  // 还没有任何计费(全新会话,或整轮都失败)时显示 `0 tok` 占位,撑住统计行高度。
  // 零数据没有明细可展开,退化为不可点的纯文本(与活动胶囊同一口径)
  if (billed === 0 && usage.outputTokens === 0) {
    return (
      <span className="stat-pill-anchor" data-stat="usage">
        <span className="stat-pill static"><span className="stat-pill-icon" aria-hidden><IconDatabase16 size={12} /></span>
          <span className="stat-pill-label">{label}</span></span>
      </span>
    );
  }
  return (
    <Pill id="usage" icon={<IconDatabase16 size={12} />} label={label} title="Token 用量"
      ariaLabel={hitLabel === null ? `${total} tok` : `${total} tok · ${hitLabel}`}>
      <div className="stat-dialog-total">{formatExactTokens(billed + usage.outputTokens)} tok</div>
      <dl className="stat-dialog-details" data-session-stats-usage>
        <Row label="缓存命中" value={hit === null ? null : `${hit}%`} />
        <Row label="输入(未命中)" value={formatExactTokens(usage.uncachedInputTokens)} />
        <Row label="缓存读取" value={formatExactTokens(usage.cacheReadTokens)} />
        {/* 多数网关不报写入缓存:为 0 时整行不显示,而不是显示 0 */}
        <Row label="缓存写入" value={usage.cacheWriteTokens !== 0 ? formatExactTokens(usage.cacheWriteTokens) : null} />
        <Row label="输出" value={formatExactTokens(usage.outputTokens)} />
      </dl>
      {usage.samples === 0 && <div className="stat-dialog-note">本会话没有可用用量样本</div>}
    </Pill>
  );
}

/**
 * 单轮用量胶囊(照搬 dsh 的 TurnUsagePanel):挂在**每条回复**的操作栏末尾,形如
 *   ⟨数据仓⟩ 用量 31.2M tok
 * 点击展开「本轮用量」明细(缓存命中 / 输入(未命中) / 缓存读取 / 缓存写入 / 输出)。
 *
 * 与会话级 UsagePill 的区别只在口径:这里是**一轮**(该轮所有步 + 重试的多次尝试),
 * 由服务端在 turn/end 折叠后下发(见 foldLastTurnTokenUsage)。
 * 一轮没有任何样本时由调用方**不渲染**这个胶囊 —— 不显示 0 tok(没有数据 ≠ 用量为零)。
 */
export function TurnUsagePill({ usage }: { usage: TokenUsageTotals }) {
  const billed = billedInput(usage);
  const hit = cacheHitText(usage);
  const total = formatTokens(billed + usage.outputTokens);
  return (
    <Pill id="turn-usage" icon={<IconDatabase16 size={12} />} label={`用量 ${total} tok`} title="本轮用量"
      ariaLabel={hit === null ? `本轮用量 ${total} tok` : `本轮用量 ${total} tok · 缓存命中 ${hit}%`}>
      <div className="stat-dialog-total">{formatExactTokens(billed + usage.outputTokens)} tok</div>
      <dl className="stat-dialog-details" data-turn-usage-details>
        <Row label="缓存命中" value={hit === null ? null : `${hit}%`} />
        <Row label="输入(未命中)" value={formatExactTokens(usage.uncachedInputTokens)} />
        <Row label="缓存读取" value={formatExactTokens(usage.cacheReadTokens)} />
        <Row label="缓存写入" value={usage.cacheWriteTokens !== 0 ? formatExactTokens(usage.cacheWriteTokens) : null} />
        <Row label="输出" value={formatExactTokens(usage.outputTokens)} />
      </dl>
    </Pill>
  );
}

/** 零值兜底:统计/用量还没到手时,两个胶囊也要在(渲染成 `0 轮 0 步` / `0 tok`) */
const EMPTY_STATS: SessionStatsInfo = {
  turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0
};
const EMPTY_USAGE: TokenUsageTotals = {
  uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, samples: 0
};

/** 两个胶囊常驻(零数据时为静态占位文本) */
export default function StatsPills({ usage, stats }: Props) {
  return (
    <div className="stats-pills">
      <ActivityPill stats={stats ?? EMPTY_STATS} />
      <UsagePill usage={usage ?? EMPTY_USAGE} />
    </div>
  );
}
