// /计划 与 /目标 两个命令的端到端验证(移植自 deepseek-harness plan/plan-mode + packages/goal):
// 1. 目标域(goal.ts):命令语法、CAS 修订栅栏、阶段迁移、严格折叠(轮次归属必须恰好是下一轮)。
// 2. /计划:进入/退出计划模式 = 权限档位 'plan' 的切换,退出回到进入前的档位;计划策略只进运行时快照。
// 3. exit_plan_mode:只在计划模式可用、要求 # 标题;用户批准后退出计划模式,选择继续规划则把反馈回给模型。
// 4. 模型侧目标工具:create_goal 必须由人类直接请求发起;update_goal 的 CAS 与 blocked 轮次下限。
// 5. 自动续跑:目标 active+armed 时空闲即续一轮,轮次计入日志;预算耗尽记 round-limit 受阻并停下。
// 注意:本测试写会话历史,需在临时目录隔离运行(同 test/todo-plan.test.js)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-goal-'));

const { Agent, toolRegistry } = await import('../server/agent/agent.ts');
const { sshManager: ssh } = await import('../server/core/ssh-manager.ts');
const { parseGoalCommand, runGoalCommand, foldGoal, goalView, GoalError, pauseGoal } = await import('../server/agent/goal.ts');
const { isPlanMode, modeBeforePlan } = await import('../server/agent/plan-mode.ts');
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

  // ---- 场景 2:/计划 进入与退出 ----
  console.log('\n[场景 2] /计划:进入/退出计划模式,并回到进入前的档位');
  {
    const { agent, sid } = makeAgent();
    check('场景2: 初始不在计划模式', agent.isPlanMode(sid) === false);
    const inPlan = agent.planCommand('', sid);
    check('场景2: /计划 进入计划模式', inPlan.kind === 'success' && inPlan.mode === 'plan' && agent.isPlanMode(sid) === true, JSON.stringify(inPlan));
    check('场景2: 进入计划模式不改全局默认档位', agent.getDefaultPermissionMode() !== 'plan');
    check('场景2: 计划模式下策略段进入运行时快照', /计划模式/.test(agent._buildRuntimeContext('plan', sid, []))
      && !/通过 exit_plan_mode/.test(agent._buildRuntimeContext('confirm', sid, [])));
    const again = agent.planCommand('', sid);
    check('场景2: 重复进入是幂等的', again.mode === 'plan' && /已在计划模式/.test(again.text));

    const off = agent.planCommand('off', sid);
    check('场景2: /计划 off 退出并回到进入前的档位', off.mode === 'confirm' && agent.isPlanMode(sid) === false, JSON.stringify(off));
    check('场景2: 退出后再 off 是幂等的', /当前不在计划模式/.test(agent.planCommand('off', sid).text));

    // 进入前是 auto-edit:退出应回到 auto-edit(而不是全局默认)
    agent.setPermissionMode('auto-edit', sid);
    agent.planCommand('', sid);
    check('场景2: 退出回到进入前那一档(auto-edit)', agent.planCommand('off', sid).mode === 'auto-edit');
    // off 带附件必须在变更前拒绝
    agent.planCommand('', sid);
    const refused = agent.planCommand('off', sid, ['att_x']);
    check('场景2: /计划 off 不接受附件且保持计划模式', refused.kind === 'error' && agent.isPlanMode(sid) === true, JSON.stringify(refused));
    agent.planCommand('off', sid);

    check('场景2: 纯函数 modeBeforePlan 取最后一次非 plan 档位',
      modeBeforePlan([ev('permission/mode', { mode: 'confirm' }), ev('permission/mode', { mode: 'plan' })]) === 'confirm'
      && modeBeforePlan([ev('permission/mode', { mode: 'plan' })], 'full-access') === 'full-access'
      && isPlanMode([ev('permission/mode', { mode: 'plan' })]) === true);
  }

  // ---- 场景 3:exit_plan_mode 的审阅回环 ----
  console.log('\n[场景 3] exit_plan_mode:批准退出计划模式 / 继续规划把反馈回给模型');
  {
    const { agent, sid } = makeAgent();
    agent.planCommand('', sid);
    // 工具 ctx 里的 emit 必须被捕获:askUserQuestion 靠它把题面广播给前端(测试据此拿到 askId)
    const pushed = [];
    const execPlan = (args) => toolRegistry.execute({
      name: 'exit_plan_mode',
      args,
      invokeCtx: toolCtx(agent._runtimes.get(sid).session, sid, { emit: (_e, p) => pushed.push(p) })
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
    answerAskUser(ask.askId, [{ id: 'plan-review', selected: ['继续规划'], custom: '风险没写' }]);
    const kept = await pending;
    check('场景3: 选择继续规划 → 工具报错并带回反馈', kept.isError === true && /风险没写/.test(kept.content), kept.content);
    check('场景3: 仍在计划模式', agent.isPlanMode(sid) === true);

    const approved = call();
    const ask2 = await waitAsk();
    answerAskUser(ask2.askId, [{ id: 'plan-review', selected: ['批准'] }]);
    const ok = await approved;
    check('场景3: 批准后退出计划模式', ok.isError === false && agent.isPlanMode(sid) === false, ok.content);
    check('场景3: 批准后的工具结果说明从下一步执行', /已退出计划模式/.test(ok.content), ok.content);

    const outside = await execPlan({ plan: '# x' });
    check('场景3: 非计划模式下拒绝调用', outside.isError === true && /只能在计划模式下使用/.test(outside.content), outside.content);
    agent.planCommand('', sid);
    const noHeading = await execPlan({ plan: '没有标题' });
    check('场景3: 缺少 # 标题时拒绝', noHeading.isError === true && /# 标题/.test(noHeading.content), noHeading.content);
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
    const rounds = events.filter((e) => e.type === 'user/message' && e.data?.source === 'goal');
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
  }

  console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
