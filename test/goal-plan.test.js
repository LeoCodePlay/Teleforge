// /计划 与 /目标 两个命令的端到端验证(移植自 deepseek-harness plan/plan-mode + packages/goal):
// 1. 目标域(goal.ts):命令语法、CAS 修订栅栏、阶段迁移、严格折叠(轮次归属必须恰好是下一轮)。
// 2. /计划:独立的 plan/mode 状态机(committed/queued/cancelled/noop,pending 到 step 边界),
//    与权限档位正交;plan:policy 提示段只在该状态生效时进运行时快照。
// 3. exit_plan_mode:只在计划模式可用、要求 # 标题;批准退出计划模式(到边界才落盘),继续规划把反馈回给模型。
// 4. 模型侧目标工具:create_goal 必须由人类直接请求发起;update_goal 的 CAS 与 blocked 轮次下限。
// 5. 自动续跑:目标 active+armed 时空闲即续一轮,轮次计入日志;预算耗尽记 round-limit 受阻并停下。
// 注意:本测试写会话历史,需在临时目录隔离运行(同 test/todo-plan.test.js)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-goal-'));

const { Agent, toolRegistry, agent: singletonAgent } = await import('../server/agent/agent.ts');
const { sshManager: ssh } = await import('../server/core/ssh-manager.ts');
const { parseGoalCommand, runGoalCommand, foldGoal, goalView, GoalError, pauseGoal } = await import('../server/agent/goal.ts');
const {
  foldPlanActive, planFirstHeading, PLAN_APPROVE_LABEL, PLAN_KEEP_PLANNING_LABEL
} = await import('../server/agent/plan-mode.ts');
const { answerAskUser } = await import('../server/agent/ask-user.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

function setupSsh() {
  ssh.status = 'connected';
  ssh.platform = 'posix';
  ssh.workspace = '/home';
  ssh.hostInfo = { host: 'h', port: 22, username: 'u' };
}

const makeAgent = () => {
  const events = [];
  const agent = new Agent({ emit: (e, p) => events.push([e, p]) });
  agent.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake' });
  agent.clearHistory();
  return { agent, events, sid: agent.sessionId };
};
const ev = (type, data) => ({ type, data });
const toolCtx = (session, sid, extra = {}) => ({ session, sid, emit: () => {}, ...extra });

async function waitIdle(agent, sid, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!agent.busyIds().includes(sid)) {
      await new Promise((r) => setTimeout(r, 20));
      if (!agent.busyIds().includes(sid)) return true;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

/** 清场:把该 agent 所有会话的目标都停掉并等它们跑完,避免上一场景的续跑轮飘进下一场景。 */
async function settle(agent) {
  for (const sid of agent.busyIds()) {
    try { agent.goalCommand('clear', sid); } catch { /* 无目标/无会话忽略 */ }
    try { agent.stop(sid); } catch { /* 忽略 */ }
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 3000 && agent.busyIds().length > 0) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function main() {
  setupSsh();
  // 看门狗:任何一步挂死都判失败退出,而不是把整条测试链拖到超时
  const watchdog = setTimeout(() => { console.error('\n测试超时(60s),已判定失败'); process.exit(1); }, 60_000);
  watchdog.unref?.();

  // ---- 场景 1:目标域纯函数 ----
  console.log('\n[场景 1] 目标域:命令语法 / CAS / 阶段迁移 / 严格折叠');
  {
    check('场景1: 裸输入 = 查看', parseGoalCommand('').kind === 'show');
    check('场景1: 控制词只在整个输入时生效', parseGoalCommand('pause after check').kind === 'create'
      && parseGoalCommand('pause after check').objective === 'pause after check');
    check('场景1: edit 需要目标描述', parseGoalCommand('edit').kind === 'invalid-edit'
      && parseGoalCommand('edit 新目标').objective === '新目标');

    const events = [];
    const session = { events, append: (type, data) => { const e = { seq: events.length, time: Date.now(), type, data }; events.push(e); return e; } };
    check('场景1: 无目标时查看给出用法', runGoalCommand(session, '').kind === 'success'
      && /用法/.test(runGoalCommand(session, '').text));
    const created = runGoalCommand(session, '把文档全部补齐');
    check('场景1: 创建成功并激活', created.kind === 'success' && /已创建目标/.test(created.text)
      && created.goal.phase === 'active' && created.goal.activation === 'armed', JSON.stringify(created.goal));
    check('场景1: 轮次从 0 起算、默认上限 256', created.goal.roundsStarted === 0 && created.goal.maxGoalRounds === 256);

    const dup = runGoalCommand(session, '换个目标');
    check('场景1: 未完成的目标不能被直接替换', dup.kind === 'error' && /已有一个进行中的目标/.test(dup.text));

    const edited = runGoalCommand(session, 'edit 把文档和测试都补齐');
    check('场景1: edit 换描述、修订自增、阶段不变', edited.goal.objective === '把文档和测试都补齐'
      && edited.goal.revision === created.goal.revision + 1 && edited.goal.phase === 'active');

    // 陈旧修订必须被拒(fold 之外的 CAS 栅栏)
    const stale = (() => {
      try {
        pauseGoal(session, { id: created.goal.id, revision: 1 });
        return null;
      } catch (e) { return e; }
    })();
    check('场景1: 陈旧修订被拒', stale instanceof GoalError && stale.code === 'GOAL_STALE_REVISION', String(stale));

    const paused = runGoalCommand(session, 'pause');
    check('场景1: pause 解除续跑授权', paused.goal.phase === 'paused' && paused.goal.activation === 'disarmed');
    const resumed = runGoalCommand(session, 'resume');
    check('场景1: resume 重新授权', resumed.goal.phase === 'active' && resumed.goal.activation === 'armed');

    // 严格折叠:只有"当前修订的下一轮"才被承认
    const before = foldGoal(events).roundsStarted;
    events.push(ev('user/message', { content: 'x', source: 'goal', goalId: resumed.goal.id, revision: resumed.goal.revision, round: 1 }));
    check('场景1: 合法轮次推进 roundsStarted', foldGoal(events).roundsStarted === before + 1);
    let bad = null;
    try { foldGoal([...events, ev('user/message', { content: 'x', source: 'goal', goalId: resumed.goal.id, revision: resumed.goal.revision, round: 9 })]); } catch (e) { bad = e; }
    check('场景1: 跳号轮次在折叠时报错', bad !== null, String(bad));

    const cleared = runGoalCommand(session, 'clear');
    check('场景1: clear 后没有当前目标', cleared.kind === 'success' && goalView(session) === undefined);
    check('场景1: 清除后可以再创建', runGoalCommand(session, '新目标').kind === 'success');
  }

  // ---- 场景 2:/计划 的开关状态机(对齐 dsh PlanModeController)----
  console.log('\n[场景 2] /计划:独立 plan/mode 状态机(committed/queued/cancelled/noop)');
  {
    const { agent, sid } = makeAgent();
    // plan/mode 的广播走模块级单例 agent(计划模式的宿主回调注册在单例创建之前,回调体延迟取它)——
    // 这里临时接管单例的 emit,专门验广播,结束后原样还原。
    const singletonEvents = [];
    const origEmit = singletonAgent.emit;
    singletonAgent.emit = (event, payload, extra) => { singletonEvents.push([event, payload]); };
    const session = agent._runtimes.get(sid).session;
    const planEvents = () => session.events.filter((e) => e.type === 'plan/mode').map((e) => e.data.active);

    check('场景2: 初始不在计划模式', agent.isPlanMode(sid) === false && foldPlanActive(session.events) === false);

    const inPlan = agent.planCommand('', sid);
    check('场景2: /计划 进入 → dsh 原文回执 + 已落盘',
      inPlan.kind === 'success' && inPlan.text === 'Plan mode on. Use /plan off to leave.'
      && inPlan.active === true && agent.isPlanMode(sid) === true, JSON.stringify(inPlan));
    check('场景2: 落成一条 plan/mode 事件(整值替换)', JSON.stringify(planEvents()) === '[true]', JSON.stringify(planEvents()));
    check('场景2: 计划模式不改权限档位(正交)', agent.getPermissionMode(sid) === 'confirm'
      && agent.getDefaultPermissionMode() !== 'plan');
    check('场景2: plan:policy 段只在计划模式生效时进入运行时快照',
      /计划模式/.test(agent._buildRuntimeContext('confirm', sid, []))
      && !/通过 exit_plan_mode/.test(agent._buildRuntimeContext('confirm', agent.createSession().id, [])));
    check('场景2: 状态变化已广播给前端(plan_mode_changed)',
      singletonEvents.some(([e, p]) => e === 'agent' && p?.event === 'plan_mode_changed' && p?.active === true),
      JSON.stringify(singletonEvents.filter(([e, p]) => p?.event === 'plan_mode_changed')));

    const again = agent.planCommand('', sid);
    check('场景2: 重复进入是 noop(幂等)', again.active === true
      && again.text === 'Entering plan mode (applies from the next step). Use /plan off to leave.'
      && JSON.stringify(planEvents()) === '[true]', JSON.stringify(again));

    const off = agent.planCommand('off', sid);
    check('场景2: /计划 off → dsh 原文回执 + 已退出',
      off.kind === 'success' && off.text === 'Plan mode off.' && off.active === false
      && agent.isPlanMode(sid) === false, JSON.stringify(off));
    check('场景2: 退出后再 off 读作幂等', agent.planCommand('off', sid).text === 'Plan mode is already inactive.',
      agent.planCommand('off', sid).text);

    // 回合开着 → queued:选择先 pending,到 step 边界才落盘(dsh 的 set/onBoundary)
    agent.planCommand('off', sid); // 先确保关闭
    session.append('turn/start', { turn: 1 });
    const queued = agent.setPlanActive(true, sid);
    check('场景2: 回合开着 → queued,状态留在 pending', queued === 'queued' && agent.getPlanMode(sid).pending === true
      && agent.isPlanMode(sid) === false, JSON.stringify({ queued, view: agent.getPlanMode(sid) }));
    check('场景2: pending 期间不再重复排队(noop)', agent.setPlanActive(true, sid) === 'noop');
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    // 下一个 step 边界:落盘(agent 在每个模型请求前调用)
    agent._applyPlanBoundaryForTest(session, sid);
    check('场景2: 边界后 pending 落成事件', agent.isPlanMode(sid) === true && agent.getPlanMode(sid).pending === undefined,
      JSON.stringify(agent.getPlanMode(sid)));

    // 回合开着时撤销一个已 pending 的进入:logged 本来就是 false → cancelled
    agent.planCommand('off', sid);
    session.append('turn/start', { turn: 2 });
    agent.setPlanActive(true, sid);
    const cancelled = agent.setPlanActive(false, sid);
    check('场景2: 撤销 pending 的进入 → cancelled,且日志无新增',
      cancelled === 'cancelled' && agent.isPlanMode(sid) === false, String(cancelled));
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });

    // off 带附件必须在变更前拒绝(dsh: 'Attachments cannot accompany /plan off.')
    agent.planCommand('', sid);
    const refused = agent.planCommand('off', sid, ['att_x']);
    check('场景2: /计划 off 不接受附件且保持计划模式',
      refused.kind === 'error' && refused.text === 'Attachments cannot accompany /plan off.'
      && agent.isPlanMode(sid) === true, JSON.stringify(refused));
    agent.planCommand('off', sid);

    // 模型切回默认模式的通知(harness narration):请求头部说 on、现在 off → 补一条通知
    // 这一段单独用一条新会话,避免前面 synthetic turn 的配平状态干扰 hasOpenTurn。
    const n2 = makeAgent();
    const ns = n2.agent._runtimes.get(n2.sid).session;
    n2.agent.planCommand('', n2.sid);              // committed:on
    n2.agent._notePlanHeaderForTest(ns, true);     // 模拟"上一轮请求已被告知 on"
    n2.agent.planCommand('off', n2.sid);           // 回合空闲 → committed:off,与被告知的 on 不同 → 补通知
    const notice = ns.events.find((e) => e.type === 'user/message'
      && e.data?.content === 'The user switched this session back to the default mode.');
    check('场景2: 模式与"模型上次被告知的"不同时补通知(dsh narration)', !!notice
      && notice.data?.source?.form === 'notice', JSON.stringify(notice?.data?.source));
    check('场景2: 纯函数:折叠最后一条 plan/mode、首个 # 标题',
      foldPlanActive([ev('plan/mode', { active: true }), ev('plan/mode', { active: false })]) === false
      && foldPlanActive([]) === false
      && planFirstHeading('# 文档补齐计划\n\n正文') === '文档补齐计划'
      && planFirstHeading('没有标题') === undefined);
    singletonAgent.emit = origEmit;
  }

  // ---- 场景 3:exit_plan_mode 的审阅回环 ----
  console.log('\n[场景 3] exit_plan_mode:批准退出计划模式 / 继续规划把反馈回给模型');
  {
    const { agent, sid } = makeAgent();
    const session = agent._runtimes.get(sid).session;
    agent.planCommand('', sid);
    // 工具 ctx 里的 emit 必须被捕获:askUserQuestion 靠它把题面广播给前端(测试据此拿到 askId)
    const pushed = [];
    const execPlan = (args) => toolRegistry.execute({
      name: 'exit_plan_mode',
      args,
      invokeCtx: toolCtx(session, sid, { emit: (_e, p) => pushed.push(p) })
    });
    const call = () => execPlan({ plan: '# 文档补齐计划\n\n1. 写文档' });
    // emit 是在工具执行的 async 链里发出的:等一小会儿再读(生产路径由前端事件驱动,无此问题)。
    // 必须等"新的一批"提问 —— 上一轮审阅的 ask_user 事件仍在 pushed 里,直接取最后一条会拿到旧 askId。
    let askSeen = 0;
    const waitAsk = async () => {
      for (let i = 0; i < 400; i++) {
        const all = pushed.filter((p) => p && p.event === 'ask_user');
        if (all.length > askSeen) { askSeen = all.length; return all[all.length - 1]; }
        await new Promise((r) => setTimeout(r, 5));
      }
      return null;
    };
    const pending = call();
    const ask = await waitAsk();
    check('场景3: 计划被送进审阅题面', !!ask && /文档补齐计划/.test(ask.questions[0].detail || ''), JSON.stringify(ask && ask.questions));
    check('场景3: 题面按 dsh 原文(id/标题/两个选项/意图)',
      ask.questions[0].id === 'plan-review' && ask.questions[0].header === 'Plan review'
      && ask.questions[0].question === 'Approve this plan and leave plan mode?'
      && ask.questions[0].options[0].label === PLAN_APPROVE_LABEL
      && ask.questions[0].options[1].label === PLAN_KEEP_PLANNING_LABEL
      && ask.questions[0].intent?.kind === 'plan-review', JSON.stringify(ask.questions[0]));

    answerAskUser(ask.askId, [{ id: 'plan-review', selected: [PLAN_KEEP_PLANNING_LABEL], custom: '风险没写' }]);
    const kept = await pending;
    check('场景3: 选择继续规划 → dsh 原文错误结果并带回反馈',
      kept.isError === true && kept.content.includes('The user chose to keep planning; their feedback: 风险没写'), kept.content);
    check('场景3: 仍在计划模式', agent.isPlanMode(sid) === true);

    const keptNoFeedback = call();
    const askKeep = await waitAsk();
    answerAskUser(askKeep.askId, [{ id: 'plan-review', selected: [PLAN_KEEP_PLANNING_LABEL] }]);
    const kept2 = await keptNoFeedback;
    check('场景3: 不带反馈的继续规划用 dsh 的另一句原文',
      kept2.content.includes('The user chose to keep planning; revise the plan and present it again.'), kept2.content);

    const approved = call();
    const ask2 = await waitAsk();
    answerAskUser(ask2.askId, [{ id: 'plan-review', selected: [PLAN_APPROVE_LABEL] }]);
    const ok = await approved;
    check('场景3: 批准后的工具结果(harness render 原文:批准=已退出计划模式)',
      ok.isError === false && /Plan approved — plan mode exited/.test(ok.content), ok.content);
    // dsh:批准的选择在**下一个 step 边界**才落成 plan/mode。这里在回合开着的情况下再批一次,
    // 验证它确实先 pending(本轮剩下的工具批次仍看到计划指引),边界到了才真正退出。
    agent.planCommand('', sid);
    session.append('turn/start', { turn: 9 });
    const approvedOpen = call();
    const ask3 = await waitAsk();
    answerAskUser(ask3.askId, [{ id: 'plan-review', selected: [PLAN_APPROVE_LABEL] }]);
    const ok2 = await approvedOpen;
    check('场景3: 回合开着时批准 → 退出挂在 pending 上(边界才落盘)',
      ok2.isError === false && agent.getPlanMode(sid).pending === false && agent.isPlanMode(sid) === true,
      JSON.stringify({ view: agent.getPlanMode(sid) }));
    agent._applyPlanBoundaryForTest(session, sid);
    session.append('turn/end', { turn: 9, reason: { kind: 'completed' } });
    check('场景3: 边界后已退出计划模式', agent.isPlanMode(sid) === false, JSON.stringify(agent.getPlanMode(sid)));

    const outside = await execPlan({ plan: '# x' });
    check('场景3: 非计划模式下拒绝调用(dsh 原文)',
      outside.isError === true && /exit_plan_mode is only available in plan mode/.test(outside.content), outside.content);
    agent.planCommand('', sid);
    const noHeading = await execPlan({ plan: '没有标题' });
    check('场景3: 缺少 # 标题时拒绝(dsh 原文)',
      noHeading.isError === true
      && /requires a non-empty markdown plan starting with a # heading/.test(noHeading.content), noHeading.content);
  }

  // ---- 场景 4:模型侧目标工具 ----
  console.log('\n[场景 4] get_goal / create_goal / update_goal 的权限与 CAS');
  {
    const { agent, sid } = makeAgent();
    const session = agent._runtimes.get(sid).session;
    const exec = (name, args, extra) => toolRegistry.execute({ name, args, invokeCtx: toolCtx(session, sid, extra) });

    const none = await exec('get_goal', {});
    check('场景4: 无目标时 get_goal 返回 null', JSON.parse(none.content).goal === null, none.content);

    const byRound = await exec('create_goal', { objective: '自动轮里创建' }, { turnSource: 'goal', goalRound: { goalId: 'g', revision: 1, round: 1 } });
    check('场景4: 自动续跑轮不能创建目标', byRound.isError === true && /直接请求/.test(byRound.content), byRound.content);

    const created = await exec('create_goal', { objective: '把两个命令补齐', max_goal_rounds: 3 }, { turnSource: 'user' });
    const createdGoal = JSON.parse(created.content).goal;
    check('场景4: 人类轮可以创建目标', created.isError === false && createdGoal.objective === '把两个命令补齐'
      && createdGoal.maxGoalRounds === 3 && JSON.parse(created.content).activation === 'armed', created.content);

    const stale = await exec('update_goal', { goal_id: createdGoal.id, revision: createdGoal.revision + 5, action: 'pause' }, { turnSource: 'user' });
    check('场景4: 陈旧修订被拒', stale.isError === true && /stale goal ref/.test(stale.content), stale.content);

    const paused = await exec('update_goal', { goal_id: createdGoal.id, revision: createdGoal.revision, action: 'pause' }, { turnSource: 'user' });
    check('场景4: pause 生效', JSON.parse(paused.content).goal.phase === 'paused', paused.content);
    const pausedGoal = JSON.parse(paused.content).goal;
    const modelResume = await exec('update_goal', { goal_id: pausedGoal.id, revision: pausedGoal.revision, action: 'resume' }, { turnSource: 'user' });
    check('场景4: 模型不能恢复已暂停的目标(交给用户)', modelResume.isError === true && /user must resume/.test(modelResume.content), modelResume.content);

    const userResume = runGoalCommand(session, 'resume');
    const active = userResume.goal;
    const earlyBlock = await exec('update_goal', {
      goal_id: active.id, revision: active.revision, action: 'blocked', blocked_reason: '同一个错'
    }, { turnSource: 'goal', goalRound: { goalId: active.id, revision: active.revision, round: 1 } });
    check('场景4: 自动轮 blocked 有轮次下限', earlyBlock.isError === true && /consecutive goal rounds/.test(earlyBlock.content), earlyBlock.content);
    const humanBlock = await exec('update_goal', {
      goal_id: active.id, revision: active.revision, action: 'blocked', blocked_reason: '依赖的接口一直 500'
    }, { turnSource: 'user' });
    check('场景4: 人类可以直接叫停(blocked)', JSON.parse(humanBlock.content).goal.phase === 'blocked', humanBlock.content);
  }

  // ---- 场景 5:自动续跑 ----
  console.log('\n[场景 5] 目标自动续跑:空闲续轮 / 轮次计入 / 上限受阻');
  {
    const { agent, sid } = makeAgent();
    let calls = 0;
    agent.llm = {
      isMock: false,
      async chat() {
        calls += 1;
        if (calls === 1) {
          return {
            content: '已建立目标',
            toolCalls: [{ id: 'c1', name: 'create_goal', arguments: JSON.stringify({ objective: '把两件事做完', max_goal_rounds: 2 }) }]
          };
        }
        return { content: `第 ${calls} 次尝试`, toolCalls: [] };
      }
    };
    await agent.run('帮我长期把这件事做完');
    await waitIdle(agent, sid);

    const events = agent._runtimes.get(sid).session.events;
    // 目标轮:source 是对象 { kind:'goal', form:'notice', … }(老日志为字符串 'goal'),两种都认
    const isGoalRound = (e) => e.type === 'user/message'
      && (e.data?.source === 'goal' || e.data?.source?.kind === 'goal');
    const rounds = events.filter(isGoalRound);
    check('场景5: 自动续跑了 2 轮(等于上限)', rounds.length === 2, `实际 ${rounds.length}`);
    check('场景5: 每轮携带精确的修订与轮号', rounds.every((e, i) => e.data.round === i + 1 && !!e.data.goalId && e.data.revision >= 1));
    check('场景5: 轮次提示词是 goal_round 指令', /<goal_round>/.test(rounds[0]?.data.content || '') && /Round: 1\/2/.test(rounds[0]?.data.content || ''));
    const view = agent.getGoal(sid);
    check('场景5: 轮次上限耗尽后记 round-limit 受阻', view && view.phase === 'blocked'
      && view.blockedReason?.code === 'round-limit' && view.roundsStarted === 2, JSON.stringify(view));
    check('场景5: 受阻后不再续跑(请求次数封顶且不再增长)', calls === 4 && (await (async () => {
      await new Promise((r) => setTimeout(r, 60));
      return calls === 4;
    })()), `calls=${calls}`);
    check('场景5: 目标续跑轮不计入"用户已发消息"的会话命名', agent.sessionStarted(sid) === true
      && agent.listSessions().find((s) => s.id === sid)?.title === '帮我长期把这件事做完');

    // 人类暂停后不再续跑
    const g2 = makeAgent();
    let calls2 = 0;
    g2.agent.llm = {
      isMock: false,
      async chat() {
        calls2 += 1;
        if (calls2 === 1) return { content: '', toolCalls: [{ id: 'c1', name: 'create_goal', arguments: JSON.stringify({ objective: 'x', max_goal_rounds: 5 }) }] };
        if (calls2 === 2) return { content: '', toolCalls: [] };
        return { content: 'stopped', toolCalls: [] };
      }
    };
    await g2.agent.run('建目标');
    await waitIdle(g2.agent, g2.agent.sessionId);
    g2.agent.goalCommand('pause', g2.agent.sessionId);
    const before = calls2;
    await new Promise((r) => setTimeout(r, 60));
    check('场景5: 暂停后不再自动续跑', calls2 === before, `before=${before} after=${calls2}`);

    // 重启(重新载入会话)后授权解除:模型也不会自己接着跑
    const reloaded = g2.agent._loadHealed(g2.agent.sessionId);
    check('场景5: 重新载入会话后目标仍持久(阶段保留)', !!goalView(reloaded));
    await settle(g2.agent);
  }

  // ---- 场景 6:/目标 命令建目标后必须立刻自动开一轮 ----
  // 人类在**空闲**会话里用 /目标 建目标(harness 里是 /goal <objective>)时,这条命令本身不产生模型轮次,
  // 目标创建后就该由续跑驱动器接上第 1 轮;只在 _drain 收尾时调度会让这条路径永远停在 rounds 0/256。
  // 只验"第 1 轮真的开了":够轮后立刻 clear 止血,避免这条 256 轮上限的目标把整个套件拖慢。
  console.log('\n[场景 6] /目标 <描述> 后空闲自动开第 1 轮');
  {
    const { agent, sid } = makeAgent();
    let calls = 0;
    agent.llm = {
      isMock: false,
      async chat() {
        calls += 1;
        return { content: `第 ${calls} 轮回答`, toolCalls: [] };
      }
    };
    const created = agent.goalCommand(' 把这件事做完', sid);
    check('场景6: 命令创建成功且已授权', created.kind === 'success' && created.goal?.phase === 'active'
      && created.goal?.activation === 'armed', JSON.stringify(created.goal));

    // 等第 1 轮进入日志(服务端异步调度)
    const events = agent._runtimes.get(sid).session.events;
    const rounds = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 3000) {
        const hit = events.filter((e) => e.type === 'user/message'
          && (e.data?.source === 'goal' || e.data?.source?.kind === 'goal'));
        if (hit.length >= 1) return hit;
        await new Promise((r) => setTimeout(r, 20));
      }
      return events.filter((e) => e.type === 'user/message'
        && (e.data?.source === 'goal' || e.data?.source?.kind === 'goal'));
    })();
    check('场景6: 命令后马上排了第 1 轮目标续跑', rounds.length >= 1, `实际 ${rounds.length} 轮`);
    check('场景6: 第 1 轮带上目标轮次提示词', /<goal_round>/.test(rounds[0]?.data?.content || '')
      && /Round: 1\/256/.test(rounds[0]?.data?.content || ''), String(rounds[0]?.data?.content || '').slice(0, 140));
    check('场景6: 轮次已计入目标(至少跑了 1 轮)', (agent.getGoal(sid)?.roundsStarted ?? 0) >= 1,
      JSON.stringify(agent.getGoal(sid)));

    // 止血:清掉目标后不再续新轮(证明暂停/清除确实能拦住后续轮次)
    agent.goalCommand('clear', sid);
    const settled = await waitIdle(agent, sid);
    const afterClear = calls;
    await new Promise((r) => setTimeout(r, 120));
    check('场景6: clear 后不再续新轮', calls === afterClear, `clear 前 ${afterClear} / 之后 ${calls}`);
    check('场景6: 目标清场后会话空闲', settled || !agent.busyIds().includes(sid));
    await settle(agent);
  }

  // ---- 场景 7:暂停目标必须停住正在跑的那一轮(harness goal/changed → cancel)----
  // 用户报的差异:dsh 里点"暂停目标"对话当场停;这边过去只改目标状态、轮次照跑。
  console.log('\n[场景 7] 暂停目标 = 中止正在跑的这一轮');
  {
    const { agent, sid } = makeAgent();
    let release = () => {};
    const gate = new Promise((r) => { release = r; });
    let chatCalls = 0;
    agent.llm = {
      isMock: false,
      // 模拟"正在生成":挂住。真实 LLM 客户端会把自己的请求绑到 signal 上,中止即整轮收尾;
      // 这里的假客户端必须同样对 signal 敏感,否则测试自己把轮子挂死(不是产品行为)。
      async chat({ signal } = {}) {
        chatCalls += 1;
        await Promise.race([
          gate,
          new Promise((_, reject) => {
            if (signal?.aborted) return reject(new Error('已停止'));
            signal?.addEventListener('abort', () => reject(new Error('已停止')), { once: true });
          })
        ]);
        return { content: '继续干活', toolCalls: [] };
      }
    };
    const created = agent.goalCommand(' 把这件事做完', sid);
    check('场景7: 目标已创建并授权', created.kind === 'success' && created.goal?.activation === 'armed', JSON.stringify(created.goal));

    // 等第 1 轮真的跑起来(模型卡在闸门上)
    const started = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 3000) {
        if (chatCalls > 0) return true;
        await new Promise((r) => setTimeout(r, 20));
      }
      return false;
    })();
    check('场景7: 第 1 轮已经开始生成', started, `chatCalls=${chatCalls}`);

    // 暂停(人侧命令)→ 服务端必须中止这一轮,而不是等模型自己跑完
    const paused = agent.goalCommand('pause', sid);
    check('场景7: pause 成功且目标转为已暂停', paused.kind === 'success' && paused.goal?.phase === 'paused'
      && paused.goal?.activation === 'disarmed', JSON.stringify(paused.goal));
    check('场景7: 暂停后会话回到空闲', await waitIdle(agent, sid, 2000), `busy=${JSON.stringify(agent.busyIds())}`);
    // 闸门此刻才放行:若服务端没中止本轮,它会继续跑完(下面 byRound 断言就会挂)
    release();

    const ends = agent._runtimes.get(sid).session.events.filter((e) => e.type === 'turn/end');
    const aborted = ends.some((e) => e.data?.reason?.kind === 'aborted');
    check('场景7: 正在跑的那一轮被中止(turn/end aborted)', aborted, JSON.stringify(ends.map((e) => e.data)).slice(0, 300));

    await waitIdle(agent, sid);
    await new Promise((r) => setTimeout(r, 80));
    const after = agent._runtimes.get(sid).session.events
      .filter((e) => e.type === 'user/message' && (e.data?.source === 'goal' || e.data?.source?.kind === 'goal')).length;
    check('场景7: 暂停后不再自动续新轮', after <= 1, `目标轮数=${after}`);
    await settle(agent);
  }

  // ---- 场景 8:目标续跑轮的来源形态(通知卡片而非用户气泡)----
  console.log('\n[场景 8] 目标续跑轮:source={kind:goal, form:notice} 且轮号在事件上');
  {
    const { agent, sid } = makeAgent();
    agent.llm = { isMock: false, async chat() { return { content: '第 N 轮', toolCalls: [] }; } };
    agent.goalCommand(' 把这件事做完', sid);
    // 等第 1 轮进日志就够:形态断言只看第一条目标轮
    const round = await (async () => {
      const t0 = Date.now();
      const events = agent._runtimes.get(sid).session.events;
      while (Date.now() - t0 < 3000) {
        const hit = events.find((e) => e.type === 'user/message' && e.data?.source?.kind === 'goal');
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 20));
      }
      return agent._runtimes.get(sid).session.events
        .find((e) => e.type === 'user/message' && e.data?.source?.kind === 'goal');
    })();
    check('场景8: 目标轮 source 是对象且 kind=goal/form=notice',
      !!round && round.data.source.form === 'notice',
      JSON.stringify(round?.data?.source));
    check('场景8: 轮号与归属仍在事件数据上(折叠依赖它们)',
      Number.isSafeInteger(round?.data?.round) && typeof round?.data?.goalId === 'string',
      JSON.stringify({ round: round?.data?.round, goalId: round?.data?.goalId }));
    // 只要求"折叠把这条 notice 形态的目标轮计进去了":后台会继续跑,`roundsStarted` 是滚动值,
    // 断言 >=1(而不是 ==1),否则抄拍时机一变这条就成假警报。
    check('场景8: 折叠把通知形态的目标轮计入(roundsStarted≥1)', (agent.getGoal(sid)?.roundsStarted ?? 0) >= 1,
      JSON.stringify(agent.getGoal(sid)));
    await settle(agent);
  }

  console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
