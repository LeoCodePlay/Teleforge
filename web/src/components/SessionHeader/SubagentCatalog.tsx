// 子智能体 catalog —— 逐行照搬 deepseek-harness 的 SubagentHeaderLineage(CatalogDropdown /
// CatalogRows),样式用的是同一份 SubagentHeaderLineage.module.css 原件。
//
// 与 dsh 的差别有两处,都是**数据形态**带来的:
//   1. 数据来源:dsh 读 session 投影(subagentCatalog + tokenUsage + subagentTiming,可嵌套成树);
//      本项目读派发记录(subagent_list);子智能体默认是**常驻后台**(可续聊/可暂停,也不能再派孙代理),
//      显式前台派发才是一次性 —— 所以这里是一层平铺列表,mode 按记录的 mode 显示
//      「可继续」/「一次性」(与 dsh 的 mode.continuable / mode.oneShot 文案一致),
//      token 取 run 的 promptTokens+completionTokens,时长取 startedAt→endedAt(常驻中取 now)。
//   2. 行首不留分支占位:dsh 给叶子行渲染一个 14px 的 `.disclosureSpace`,是为了让同一层的
//      可展开行与叶子行左边界对齐;这里**整层都是叶子**,留这个空位只会让每行左边多出
//      14px + 6px 的空白,所以不渲染它(状态点直接贴着行的 9px 左内边距)。
//
// 交互照搬:悬停 150ms 展开 / 移开 120ms 收起、点击固定、点外部关闭、Esc 关闭并把焦点
// 还给触发器、方向键在行之间移动;点行 = 在主对话区打开这个子智能体,行尾按钮 = 在侧边栏打开。

import React, {
  useCallback, useEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconRefreshOutlineRegular,
  StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { SubagentRunInfo } from '../../types';
import { tSub } from './locales';
import { formatDuration, formatExactDuration, formatTokens } from './format';
import css from './SubagentHeaderLineage.module.css';

/** 菜单与视口边缘至少留出的间距(dsh 的 portal margin)。 */
const VIEWPORT_MARGIN = 12;
/** 悬停展开 / 收起的延时(dsh 原值)。 */
const HOVER_OPEN_MS = 150;
const HOVER_CLOSE_MS = 120;

/** 业务动作:由宿主(SessionHeader/App)注入。 */
export interface SubagentCatalogActions {
  /** 在主对话区打开这个子智能体(dsh 的 openChild)。 */
  openChild: (runId: string) => void;
  /** 在右侧栏打开这个子智能体(dsh 的 openChildAside)。 */
  openChildAside: (runId: string, title: string) => void;
  /** 重拉列表(dsh 的 refreshProjection)。 */
  refresh: () => void;
}

/** 列表区渲染所需的一切(宿主持有数据,组件只管展示与交互)。 */
export interface SubagentCatalogSource {
  runs: SubagentRunInfo[];
  loading: boolean;
  error: string | null;
}

function treeItems(root: HTMLElement | null): HTMLElement[] {
  return root === null
    ? []
    : Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"]:not([aria-disabled="true"])'));
}

/** 把触发器下方的可用空间算成菜单的 fixed 定位(dsh 的 catalogMenuPosition)。 */
function catalogMenuPosition(trigger: HTMLElement): CSSProperties {
  const rect = trigger.getBoundingClientRect();
  // 宽度由样式表定(.menu 的 336px / max-width);这里只用来算左右夹取,不写进 style,
  // 否则内联宽度会盖掉 dsh 原件的 336px。
  const width = Math.min(336, Math.max(240, window.innerWidth - 32));
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(rect.left, window.innerWidth - width - VIEWPORT_MARGIN),
  );
  const below = window.innerHeight - rect.bottom - 5 - VIEWPORT_MARGIN;
  if (below >= 200) {
    return { left, top: rect.bottom + 5, maxHeight: Math.min(560, below) };
  }
  const above = rect.top - 5 - VIEWPORT_MARGIN;
  const height = Math.min(560, Math.max(160, above));
  return { left, top: Math.max(VIEWPORT_MARGIN, rect.top - 5 - height), maxHeight: height };
}

/** 一次派发的总 token(输入+输出);为 0 时不显示这一格。 */
function tokenTotal(run: SubagentRunInfo): number | undefined {
  const total = (run.promptTokens || 0) + (run.completionTokens || 0);
  return total > 0 ? total : undefined;
}

/** 一次派发的活跃时长:结束后取真实耗时,常驻(running/idle)按 now 递增。 */
function durationOf(run: SubagentRunInfo, now: number): number {
  const alive = run.status === 'running' || run.status === 'idle';
  const end = run.endedAt ?? (alive ? now : run.startedAt);
  return Math.max(0, end - run.startedAt);
}

/** 子智能体的活动语义:运行中 / 已完成 / 当前未运行(dsh 的同名三态)。 */
function activityOf(run: SubagentRunInfo): 'running' | 'completed' | 'inactive' {
  if (run.status === 'running') return 'running';
  return run.status === 'done' ? 'completed' : 'inactive';
}

/** Render catalog loading without inventing child membership. */
function CatalogLoadingRows() {
  return <div className={css.notice}>{tSub('loading.label')}</div>;
}

interface CatalogRowsProps {
  source: SubagentCatalogSource;
  currentRunId: string | undefined;
  actions: SubagentCatalogActions;
  closeCatalog: () => void;
}

/** 平铺一行 = 一次派发;叶子行渲染 dsh 给叶子预留的 disclosureSpace。 */
function CatalogRows({ source, currentRunId, actions, closeCatalog }: CatalogRowsProps) {
  const { runs, loading, error } = source;
  const [now, setNow] = useState(() => Date.now());
  const running = runs.some(run => run.status === 'running' || run.status === 'idle');

  // 运行中时每秒走一次,时长那一格才会真实递增(与 dsh 同一做法)
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { setNow(Date.now()); }, 1_000);
    return () => { clearInterval(timer); };
  }, [running]);

  const emptyLoading = loading && runs.length === 0;

  return (
    <>
      {emptyLoading && <CatalogLoadingRows />}
      {error !== null && (
        <div className={css.error}>
          <span>{error || tSub('load.error')}</span>
          <button
            type="button"
            className={css.refresh}
            onClick={() => { actions.refresh(); }}
          >
            <IconRefreshOutlineRegular size={14} />
            {tSub('retry')}
          </button>
        </div>
      )}
      {runs.map((run) => {
        const isCurrent = run.runId === currentRunId;
        const label = run.description || run.runId;
        const activity = activityOf(run);
        // 模式标记与 dsh 的 mode.oneShot / mode.continuable 同一套文案:
        // 默认(后台、可续聊)= 可继续;显式前台等结果 = 一次性
        const mode = (run.mode ?? 'continuable') === 'one-shot' ? tSub('mode.oneShot') : tSub('mode.continuable');
        const activityText = activity === 'running'
          ? tSub('activity.running')
          : activity === 'completed' ? tSub('activity.completed') : tSub('activity.inactive');
        const secondary = [mode, activityText].join(' · ');
        const totalTokens = tokenTotal(run);
        const durationMs = durationOf(run, now);
        const tokenMetric = totalTokens === undefined
          ? undefined
          : tSub('tokens.total', { value: formatTokens(totalTokens, tSub) });
        const durationMetric = {
          compact: formatDuration(durationMs, tSub),
          exact: formatExactDuration(durationMs, tSub),
        };
        const metrics = [tokenMetric, durationMetric?.exact]
          .filter((value): value is string => value !== undefined)
          .join(' · ');

        const open = (): void => {
          actions.openChild(run.runId);
          closeCatalog();
        };
        const openAside = (event: React.MouseEvent<HTMLButtonElement>): void => {
          event.preventDefault();
          event.stopPropagation();
          actions.openChildAside(run.runId, label);
          closeCatalog();
        };
        const handleKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            open();
          }
        };

        return (
          <div key={run.runId} className={css.node}>
            <div
              role="treeitem"
              tabIndex={0}
              aria-level={1}
              aria-current={isCurrent || undefined}
              aria-label={[label, secondary, metrics].filter(value => value !== '').join(' ')}
              className={css.row}
              data-subagent-row={run.runId}
              onClick={open}
              onKeyDown={handleKey}
            >
              <div className={css.clickarea}>
                <span className={css.rowActivitySlot} data-subagent-activity="">
                  <StateDot state={activity === 'running' ? 'ongoing' : activity === 'completed' ? 'done' : 'idle'} />
                </span>
                <span className={css.content}>
                  <span className={`${css.label} ${isCurrent ? css.currentLabel : ''}`}>{label}</span>
                  <span className={css.summary}>{secondary}</span>
                </span>
                {metrics !== '' && (
                  <span className={css.metrics}>
                    {tokenMetric !== undefined && <span className={css.metricToken}>{tokenMetric}</span>}
                    {durationMetric !== undefined && (
                      <span
                        className={css.metricDuration}
                        data-tip={tSub('duration.exactTitle', { duration: durationMetric.exact })}
                      >
                        {durationMetric.compact}
                      </span>
                    )}
                  </span>
                )}
                {!isCurrent && (
                  <Tooltip label={tSub('open.sidebar')} side="bottom" align="end">
                    <button
                      type="button"
                      className={css.sidebarButton}
                      aria-label={tSub('open.sidebar.aria', { label })}
                      data-subagent-aside={run.runId}
                      onClick={openAside}
                      onKeyDown={(event) => { event.stopPropagation(); }}
                    >
                      <IconChevronRightOutlineRegular />
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

function SubagentSwitcherIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M5.99951 12.7L8.95546 14.9478C9.40011 15.2859 9.62244 15.455 9.87526 15.488C9.95774 15.4988 10.0413 15.4988 10.1238 15.488C10.3766 15.455 10.5989 15.2859 11.0436 14.9478L13.9995 12.7"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M13.9995 7.7417L11.0436 5.49387C10.5989 5.15574 10.3766 4.98668 10.1238 4.95362C10.0413 4.94283 9.95775 4.94283 9.87527 4.95362C9.62245 4.98668 9.40012 5.15574 8.95547 5.49387L5.99952 7.7417"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

interface CatalogDropdownProps {
  /** count = 会话头部那个「N 个子智能体」;switcher = 子会话里的面包屑标题切换器 */
  variant: 'count' | 'switcher';
  source: SubagentCatalogSource;
  currentRunId?: string;
  /** switcher 变体的标题(当前子智能体名) */
  displayTitle?: string;
  actions: SubagentCatalogActions;
}

/**
 * 渲染一个 catalog 下拉:触发器 + 336px 的 portal 菜单(dsh 的同一套交互)。
 * @param props - 变体、数据源、当前项与业务动作。
 * @returns 触发器与其菜单,或当天数据不足以构成可见入口时的 null。
 */
export function CatalogDropdown({
  variant, source, currentRunId, displayTitle, actions,
}: CatalogDropdownProps) {
  const { runs } = source;
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<CSSProperties | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(false);
  const hoverOpenTimer = useRef<number | undefined>(undefined);
  const hoverCloseTimer = useRef<number | undefined>(undefined);

  const directCount = runs.length;
  const runningCount = runs.filter(run => run.status === 'running').length;
  const totalCountKey = directCount === 1 ? 'count.total.one' : 'count.total.other';
  const runningCountKey = runningCount === 1 ? 'count.running.one' : 'count.running.other';
  const switcherDisplayTitle = runs.find(run => run.runId === currentRunId)?.description
    || displayTitle
    || '';

  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimer.current === undefined) return;
    window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = undefined;
  }, []);

  const cancelHoverOpen = useCallback(() => {
    if (hoverOpenTimer.current === undefined) return;
    window.clearTimeout(hoverOpenTimer.current);
    hoverOpenTimer.current = undefined;
  }, []);

  const changeOpen = useCallback((next: boolean, restoreFocus = false): void => {
    cancelHoverOpen();
    cancelHoverClose();
    if (next) {
      const trigger = triggerRef.current;
      if (trigger === null) return;
      setOpen(true);
      setMenuPosition(catalogMenuPosition(trigger));
    } else {
      pinnedRef.current = false;
      setOpen(false);
      setMenuPosition(undefined);
    }
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus(); });
  }, [cancelHoverClose, cancelHoverOpen]);

  const scheduleHoverOpen = useCallback((): void => {
    cancelHoverOpen();
    cancelHoverClose();
    if (open) return;
    hoverOpenTimer.current = window.setTimeout(() => {
      hoverOpenTimer.current = undefined;
      changeOpen(true);
    }, HOVER_OPEN_MS);
  }, [cancelHoverClose, cancelHoverOpen, changeOpen, open]);

  const scheduleHoverClose = useCallback((): void => {
    cancelHoverOpen();
    cancelHoverClose();
    if (pinnedRef.current) return;
    hoverCloseTimer.current = window.setTimeout(() => {
      hoverCloseTimer.current = undefined;
      changeOpen(false);
    }, HOVER_CLOSE_MS);
  }, [cancelHoverClose, cancelHoverOpen, changeOpen]);

  // 空列表时入口本身不出现(switcher 例外:标题必须在)
  const visible = variant === 'switcher'
    || source.error !== null
    || runs.length > 0;

  useEffect(() => {
    if (visible) return;
    cancelHoverOpen();
    cancelHoverClose();
    if (!open) return;
    pinnedRef.current = false;
    setOpen(false);
  }, [visible, open, cancelHoverOpen, cancelHoverClose]);

  // 点外部关闭(dsh 用 pointerdown,避免与行内点击抢事件)
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node
        && !rootRef.current?.contains(event.target)
        && !menuRef.current?.contains(event.target)
      ) {
        changeOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => { document.removeEventListener('pointerdown', closeOutside); };
  }, [open, changeOpen]);

  // 打开期间跟随窗口尺寸/滚动重新定位
  useEffect(() => {
    if (!open) return;
    const placeMenu = (): void => {
      const trigger = triggerRef.current;
      if (trigger === null) return;
      setMenuPosition(catalogMenuPosition(trigger));
    };
    window.addEventListener('resize', placeMenu);
    document.addEventListener('scroll', placeMenu, true);
    return () => {
      window.removeEventListener('resize', placeMenu);
      document.removeEventListener('scroll', placeMenu, true);
    };
  }, [open]);

  useEffect(() => () => {
    cancelHoverOpen();
    cancelHoverClose();
  }, [cancelHoverOpen, cancelHoverClose]);

  if (!visible) return null;

  const focusAt = (index: number): void => {
    const items = treeItems(menuRef.current);
    if (items.length === 0) return;
    items[(index + items.length) % items.length]?.focus();
  };

  const navigate = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = treeItems(menuRef.current);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      changeOpen(false, true);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusAt(items.length - 1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusAt(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusAt(index < 0 ? items.length - 1 : index - 1);
    }
  };

  return (
    <div
      className={`${css.root} ${variant === 'switcher' ? css.switcherRoot : ''}`}
      ref={rootRef}
      onKeyDown={navigate}
      onMouseLeave={scheduleHoverClose}
    >
      <button
        ref={triggerRef}
        onMouseEnter={scheduleHoverOpen}
        type="button"
        className={variant === 'switcher' ? css.switcherTrigger : css.trigger}
        aria-haspopup="tree"
        aria-expanded={open}
        data-subagent-catalog={variant}
        aria-label={variant === 'switcher'
          ? tSub('switcher.aria', { title: switcherDisplayTitle })
          : tSub(
            runningCount > 0 ? runningCountKey : totalCountKey,
            { count: runningCount > 0 ? runningCount : directCount },
          )}
        onClick={() => {
          cancelHoverOpen();
          cancelHoverClose();
          pinnedRef.current = true;
          if (!open) changeOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          if (!open) changeOpen(true);
          queueMicrotask(() => { focusAt(0); });
        }}
      >
        {variant === 'switcher'
          ? <span className={css.switcherTitle}>{switcherDisplayTitle}</span>
          : (
            <>
              {runningCount > 0 && (
                <span className={css.activitySlot}>
                  <StateDot state="ongoing" />
                </span>
              )}
              <span className={css.count}>{tSub(totalCountKey, { count: directCount })}</span>
            </>
          )}
        {variant === 'switcher'
          ? <SubagentSwitcherIcon />
          : <IconChevronDownOutlineRegular className={open ? css.triggerOpen : undefined} />}
      </button>
      {open && createPortal((
        <div
          ref={menuRef}
          className={css.menu}
          style={menuPosition}
          data-subagent-menu=""
          onMouseEnter={cancelHoverClose}
          onMouseLeave={scheduleHoverClose}
        >
          <div className={css.menuBody} role="tree" aria-label={tSub('tree.aria')}>
            <CatalogRows
              source={source}
              currentRunId={currentRunId}
              actions={actions}
              closeCatalog={() => { changeOpen(false); }}
            />
          </div>
        </div>
      ), document.body)}
    </div>
  );
}

/** 会话头部动作区里的 catalog 入口(根会话用)。 */
export function SubagentCatalogAction(props: {
  source: SubagentCatalogSource;
  currentRunId?: string;
  actions: SubagentCatalogActions;
}) {
  return <CatalogDropdown variant="count" {...props} />;
}
