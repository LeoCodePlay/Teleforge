// 会话头部(「会话的多功能顶部」)—— 照搬 deepseek-harness 的
// ConversationSessionHeader:左边是会话层级面包屑(在子智能体会话里变成
// 「父会话 / 当前子智能体 ▾ 切换器」),右边是会话头部**动作区**
// (conversation.session.header.actions),里面按 order 排列:
//
//   子智能体 catalog(order -30,领先整条带) · 后台任务(order +20)
//
// 与旧 ActivityBar 的区别:旧实现是「两个胶囊 + 一个右侧大抽屉」,把入口和内容
// 都挪到了抽屉里;DSH 里这两个入口**各自是一个贴在头部的小弹层**(子智能体 336px 的树,
// 后台任务 500px 的列表),而且子智能体点一下是**在主对话区打开那个子会话**
// (面包屑随之出现),不是一个只读抽屉。
//
// 数据:catalog 走 useSubagentRuns(subagent_list + subagent_changed),
// 后台任务走 JobListAction 自己订阅的 ai_term_* 通道。

import React from 'react';
import JobListAction from './JobListAction';
import { SubagentCatalogAction, CatalogDropdown, type SubagentCatalogActions } from './SubagentCatalog';
import { useSubagentRuns } from '../../hooks/useSubagentRuns';
import css from './SessionHeader.module.css';

export interface SessionHeaderProps {
  /** 当前会话 id;null = 草稿会话(既没有派发记录,也没有拉起的终端) */
  sid: string | null;
  /** 当前会话标题:面包屑的第一节(也是子智能体会话里回主会话的入口) */
  sessionTitle: string;
  /** 正在主对话区回看的子智能体 runId;null = 在主会话里 */
  openRunId: string | null;
  /** 在主对话区打开某个子智能体(DSH 的 openChild:点 catalog 的一行) */
  onOpenSubagent: (runId: string) => void;
  /** 在右侧栏打开某个子智能体(DSH 的 openChildAside:行尾的按钮) */
  onOpenSubagentAside: (runId: string, title: string) => void;
  /** 回到主会话(点面包屑里父会话那一节) */
  onBackToSession: () => void;
}

export default function SessionHeader({
  sid, sessionTitle, openRunId, onOpenSubagent, onOpenSubagentAside, onBackToSession,
}: SessionHeaderProps) {
  const { runs, loading, error, refresh } = useSubagentRuns(sid);

  const actions: SubagentCatalogActions = {
    openChild: onOpenSubagent,
    openChildAside: onOpenSubagentAside,
    refresh,
  };
  const source = { runs, loading, error };
  const openRunTitle = runs.find((r) => r.runId === openRunId)?.description || openRunId || '';

  // 面包屑:主会话只有一节;打开子智能体后是「父会话 / 当前子智能体」两节
  // (与 dsh 的 deriveAncestry 同一形态:每个 session 一节,当前节不可点)
  const crumbs = openRunId === null
    ? [{ id: sid ?? '__draft__', title: sessionTitle, subagent: false }]
    : [
      { id: 'parent', title: sessionTitle, subagent: false },
      { id: openRunId, title: openRunTitle, subagent: true },
    ];

  return (
    <div className={css.header} data-session-header="" aria-label="会话头部">
      <div className={css.titleRow}>
      <div className={css.titleCluster}>
        <nav className={css.crumbs} aria-label="会话层级">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            // 当前节不带导航,所以是纯文本而不是禁用按钮(dsh 的同一条注释)
            const title = last
              ? (
                <span className={`${css.crumb} ${crumb.subagent ? css.crumbSubagent : ''} ${css.crumbCurrent}`}>
                  {crumb.title}
                </span>
              )
              : (
                <button type="button" className={css.crumb} data-session-crumb="" onClick={onBackToSession}>
                  {crumb.title}
                </button>
              );
            return (
              <span key={crumb.id} className={css.crumbSeg}>
                {index > 0 && <span className={css.crumbSep} aria-hidden>/</span>}
                {/* dsh 的做法:子会话那一节**不渲染 title**,而是把它交给
                    conversation.session.header.lineage 槽(渲染出来的就是那个标题切换器);
                    所以这里只出现一次标题,不是「标题 + 切换器」两遍 */}
                {last && crumb.subagent
                  ? (
                    <CatalogDropdown
                      variant="switcher"
                      source={source}
                      currentRunId={openRunId ?? undefined}
                      displayTitle={crumb.title}
                      actions={actions}
                    />
                  )
                  : title}
              </span>
            );
          })}
        </nav>
        {/* 动作区:与 dsh 一样,子智能体 catalog 只在根会话出现(进了子会话就由
            上面的切换器接管导航),后台任务两个场合都在 */}
        <div className={css.headerActions} data-header-actions="">
          {openRunId === null && (
            <SubagentCatalogAction source={source} actions={actions} />
          )}
          <JobListAction sid={sid} />
        </div>
      </div>
      </div>
    </div>
  );
}
