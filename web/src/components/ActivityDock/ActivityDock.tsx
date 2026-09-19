// 统一活动面板(ActivityDock):对话区右上角**一个**悬浮胶囊 + 右侧抽屉,里面按分区放
// 「运行终端」(AI 拉起的后台进程)与「子代理」(派发的只读调研代理)。
//
// 为什么合并:两者都是"AI 在替我干活"的运行时状态,原本两个胶囊纵向叠着、两个抽屉互斥,
// 既占地方又要分别开关。合并后:
//   - 只有一个胶囊(计数 = 两类之和,任一类有在跑就高亮);
//   - 抽屉里用分区标签切换,标签上带数量与运行中小圆点;
//   - **哪个分区没内容就不显示那个标签**,两边都没内容则整块(胶囊 + 抽屉)都不存在;
//   - 两个分区常驻挂载(终端 xterm 不销毁),抽屉关闭只是移出可视区。
//
// 只在 AI 对话标签页显示:本组件挂在 agent 的 tab-pane 里,切到别的标签页时
// 该 pane 是 display:none,面板随之消失(不再跨标签页悬浮)。
import React, { useCallback, useEffect, useState } from 'react';
import AiTermPanel from '../AiTermPanel/AiTermPanel';
import SubagentPanel from '../SubagentPanel/SubagentPanel';
import { StateDot } from '../StateDot/StateDot';
import { IconApiOutline14 } from '../icons/icons';
import { useIsPhone } from '../../hooks/useMediaQuery';
import './ActivityDock.scss';

type DockTab = 'term' | 'subagent';
interface Counts { count: number; running: number }

export default function ActivityDock({ active, sid, subagentRunId, onOpenSubagent, onCloseSubagent }: {
  /** 当前是否在 AI 对话标签页(切走时自动收起抽屉) */
  active: boolean;
  /** 当前会话 id(子代理只列本会话派发的) */
  sid: string | null;
  /** 卡片上「查看会话」带来的运行记录 id:非空则自动切到子代理分区并展开 */
  subagentRunId: string | null;
  onOpenSubagent: (runId?: string) => void;
  onCloseSubagent: () => void;
}) {
  const isPhone = useIsPhone();
  const [term, setTerm] = useState<Counts>({ count: 0, running: 0 });
  const [runs, setRuns] = useState<Counts>({ count: 0, running: 0 });
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DockTab>('term');

  // 两个分区各自上报计数(回调必须稳定,否则会触发子组件 effect 抖动)
  const onTermCounts = useCallback((c: Counts) => setTerm(c), []);
  const onRunCounts = useCallback((c: Counts) => setRuns(c), []);

  const hasTerm = term.count > 0;
  const hasRun = runs.count > 0;
  const total = term.count + runs.count;
  const live = term.running > 0 || runs.running > 0;

  // 只有一个分区有内容时,自动选中它(不用用户再点一下标签)
  useEffect(() => {
    if (!hasTerm && hasRun) setTab('subagent');
    else if (hasTerm && !hasRun) setTab('term');
  }, [hasTerm, hasRun]);

  // 卡片「查看会话」:切到子代理分区并展开
  useEffect(() => {
    if (!subagentRunId) return;
    setTab('subagent');
    setOpen(true);
  }, [subagentRunId]);

  // 切走标签页 / 全部内容消失:收起
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  useEffect(() => { if (total === 0) setOpen(false); }, [total]);

  // Esc 收起(两个分区的键盘出口统一在这里,子面板不再各挂一个)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const close = useCallback(() => { setOpen(false); onCloseSubagent(); }, [onCloseSubagent]);
  const toggle = () => (open ? close() : setOpen(true));

  const termLabel = `运行终端${term.running > 0 ? `,${term.running} 个运行中` : ''}`;
  const runLabel = `子代理${runs.running > 0 ? `,${runs.running} 个运行中` : ''}`;

  return (
    <>
      {/* 悬浮胶囊:只在有内容时出现(两边都空 = 整块不存在) */}
      {total > 0 && (
        <button
          type="button"
          className={`dock-fab${live ? ' live' : ''}${open ? ' on' : ''}`}
          onClick={toggle}
          aria-expanded={open}
          aria-label={`运行与子代理(${termLabel};${runLabel})`}
          data-tip="AI 正在替你跑的进程与派发出去的调研"
        >
          <span className="dock-fab-ico"><IconApiOutline14 size={14} /></span>
          <span className="dock-fab-text">运行与子代理</span>
          <span className="dock-fab-count">{total}</span>
          {live && <StateDot state="ongoing" size={9} />}
        </button>
      )}

      {open && !isPhone && <div className="dock-backdrop" onClick={close} />}

      <aside
        className={`dock-drawer${open ? ' open' : ''}${isPhone ? ' phone' : ''}`}
        role="dialog"
        aria-modal={open}
        aria-label="运行与子代理"
        aria-hidden={!open}
      >
        <header className="dock-head">
          <span className="dock-title"><IconApiOutline14 size={14} />运行与子代理</span>
          <div className="dock-tabs" role="tablist" aria-label="面板分区">
            {hasTerm && (
              <button
                type="button"
                role="tab"
                data-dock-tab="term"
                aria-selected={tab === 'term'}
                className={`dock-tab${tab === 'term' ? ' on' : ''}`}
                onClick={() => setTab('term')}
              >
                <StateDot state={term.running > 0 ? 'ongoing' : 'done'} size={9} />
                运行终端
                <span className="dock-tab-count">{term.count}</span>
              </button>
            )}
            {hasRun && (
              <button
                type="button"
                role="tab"
                data-dock-tab="subagent"
                aria-selected={tab === 'subagent'}
                className={`dock-tab${tab === 'subagent' ? ' on' : ''}`}
                onClick={() => setTab('subagent')}
              >
                <StateDot state={runs.running > 0 ? 'ongoing' : 'done'} size={9} />
                子代理
                <span className="dock-tab-count">{runs.count}</span>
              </button>
            )}
          </div>
          <span className="dock-head-gap" />
          <button type="button" className="chip-btn" onClick={close} aria-label="收起面板">收起</button>
        </header>

        <div className="dock-body">
          {/* 两个分区常驻挂载:终端 xterm 切走不销毁,切回即恢复 */}
          <section className={`dock-pane${tab === 'term' ? ' on' : ''}`}>
            <AiTermPanel active={active} embedded onCounts={onTermCounts} />
          </section>
          <section className={`dock-pane${tab === 'subagent' ? ' on' : ''}`}>
            <SubagentPanel
              active={active}
              sid={sid}
              embedded
              open={open && tab === 'subagent'}
              runId={subagentRunId}
              onOpen={onOpenSubagent}
              onClose={close}
              onCounts={onRunCounts}
            />
          </section>
        </div>
      </aside>
    </>
  );
}
