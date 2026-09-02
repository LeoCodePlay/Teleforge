// 验证"自动续推"(移植自 deepseek-harness goal-round-driver)的三条路径:
// 1. 模型建了 todo 计划但有未完成项就宣称完成 -> 系统自动注入 goal_round 续推消息并继续循环,
//    而不是无条件 break 显示就绪(修复"复杂任务只做第一步就停")。
// 2. 模型连续多次宣称完成但计划未清空 -> 达到 GOAL_BLOCKED_AFTER 门槛后停止续推并提示"卡住"。
// 3. 模型输出因 max_tokens 被截断(finishReason='length')-> 即使无 todo 计划也自动续推。
// 同时验证 todo 全部 completed 后正常结束(不误续推)。
// 注意:本测试写会话历史,需在临时 DATA_DIR 里隔离运行。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-cnt-'));
const { Agent } = await import('../server/agent/agent.ts');
const { sshManager: ssh } = await import('../server/core/ssh-manager.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

function setupSsh() {
  ssh.status = 'connected';
  ssh.platform = 'posix';
  ssh.workspace = '/home';
  ssh.hostInfo = { host: 'h', port: 22, username: 'u' };
  ssh.listDir = async () => ([{ name: 'README.md', type: 'file', size: 10, mtime: 0 }]);
  ssh.atype = async () => 'file';
  ssh.stat = async () => ({ isDirectory: () => true });
}

const makeAgent = () => {
  const events = [];
  const agent = new Agent({ emit: (e, p) => events.push([e, p]) });
  agent.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake' });
  return { agent, events };
};
// 事件以 ['agent', {event, ...}] 形式发出:helper 需解出 payload.event
const sawAgent = (events, ev, pred = () => true) => events.some(([e, p]) => e === 'agent' && p && p.event === ev && pred(p));
const doneIters = (events) => {
  const d = events.find(([e, p]) => e === 'agent' && p && p.event === 'done');
  return d ? d[1].iters : -1;
};
const doneText = (events) => {
  const d = events.find(([e, p]) => e === 'agent' && p && p.event === 'done');
  return d ? d[1].text : '';
};

async function main() {
  setupSsh();

  // ---- 场景 1:todo 未完成即宣称完成 -> 自动续推直到 todo 全 completed ----
  console.log('\n[场景 1] todo 未完成即宣称完成,应自动续推');
  {
    const { agent, events } = makeAgent();
    let calls = 0;
    const plan = [
      { content: '第一步:读取 README', status: 'pending' },
      { content: '第二步:写入 notes', status: 'pending' }
    ];
    agent.llm = {
      isMock: false,
      async chat({ messages }) {
        calls += 1;
        // 第 1 次:建计划(全部 pending)
        if (calls === 1) {
          return { content: '', toolCalls: [{ id: 't1', name: 'todo_write', arguments: JSON.stringify({ todos: plan }) }] };
        }
        // 第 2 次:模型"偷懒",只给文字不调工具(此时 todo 仍全 pending) -> 应触发续推
        if (calls === 2) {
          const hasGoalRound = messages.some((m) => m.role === 'user' && String(m.content).includes('<goal_round>'));
          return { content: '好的,第一步看过了' + (hasGoalRound ? '(续推)' : ''), toolCalls: [] };
        }
        // 第 3 次:完成全部计划
        if (calls === 3) {
          return { content: '', toolCalls: [{ id: 't2', name: 'todo_write', arguments: JSON.stringify({ todos: plan.map((t) => ({ ...t, status: 'completed' })) }) }] };
        }
        // 第 4 次:全部 completed,正常收尾
        return { content: '全部完成', toolCalls: [] };
      }
    };
    await agent.run('帮我完成一个多步任务');
    check('场景1: 发生自动续推(第 2 次模型回复前注入了 goal_round 消息)', calls >= 4, `实际调用 ${calls} 次`);
    check('场景1: 未提前 done(最终 done 的 iters 在最后一步之后)', doneIters(events) >= 4, `iters=${doneIters(events)}`);
    check('场景1: 事件日志含 goal_round 续推 notice', sawAgent(events, 'notice', (p) => /自动续推/.test(p.text || '')), '');
    const goalRound = agent.getHistory().some((m) => m.role === 'user' && /↻ 自动续推/.test(m.content || ''));
    check('场景1: 前端投影可见续推标记(display)', goalRound);
    check('场景1: 最终文本为末轮正文', doneText(events) === '全部完成');
  }

  // ---- 场景 2:连续宣称完成但计划未清空 -> GOAL_BLOCKED_AFTER 后停止并提示卡住 ----
  console.log('\n[场景 2] 连续宣称完成但计划未清空,应达到门槛后停止续推');
  {
    const { agent, events } = makeAgent();
    let calls = 0;
    const incomplete = [{ content: '任务 X', status: 'in_progress' }];
    agent.llm = {
      isMock: false,
      async chat() {
        calls += 1;
        if (calls === 1) {
          return { content: '', toolCalls: [{ id: 't1', name: 'todo_write', arguments: JSON.stringify({ todos: incomplete }) }] };
        }
        // 之后每次都宣称完成但从不标记 completed -> 续推 3 次后应停止
        return { content: `第 ${calls} 次宣称完成`, toolCalls: [] };
      }
    };
    await agent.run('做一件事');
    const stuck = sawAgent(events, 'notice', (p) => /疑似卡住/.test(p.text || ''));
    check('场景2: 提示了"疑似卡住"', stuck);
    // GOAL_BLOCKED_AFTER=3,故最大调用 = 1(todo) + 1(首次宣称) + 3(续推) = 5,不超过该值
    check('场景2: 续推次数受门槛约束(未无限循环)', calls <= 6, `实际调用 ${calls} 次`);
    check('场景2: 最终仍 emit done(结束而非挂死)', sawAgent(events, 'done'));
  }

  // ---- 场景 3:输出被截断(finishReason=length)-> 无 todo 也自动续推 ----
  console.log('\n[场景 3] max_tokens 截断应自动续推而非判完成');
  {
    const { agent, events } = makeAgent();
    let calls = 0;
    agent.llm = {
      isMock: false,
      async chat() {
        calls += 1;
        if (calls === 1) {
          return { content: '输出到一半被截断', toolCalls: [], finishReason: 'length' };
        }
        return { content: '继续完成后的完整输出', toolCalls: [], finishReason: 'stop' };
      }
    };
    await agent.run('一个问题');
    check('场景3: 截断后继续请求了模型(未直接结束)', calls >= 2, `实际调用 ${calls} 次`);
    check('场景3: 最终 done 文本来自续推后的输出', doneText(events) === '继续完成后的完整输出');
    check('场景3: 事件日志含截断续推提示', sawAgent(events, 'notice', (p) => /截断|自动续推/.test(p.text || '')));
  }

  // ---- 场景 4:todo 全部 completed -> 正常结束,不误续推 ----
  console.log('\n[场景 4] todo 全部 completed 应正常结束');
  {
    const { agent, events } = makeAgent();
    let calls = 0;
    agent.llm = {
      isMock: false,
      async chat() {
        calls += 1;
        if (calls === 1) {
          return { content: '', toolCalls: [{ id: 't1', name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: '单步', status: 'completed' }] }) }] };
        }
        return { content: '完成了', toolCalls: [] };
      }
    };
    await agent.run('做一件已完成的事');
    check('场景4: 未触发续推', calls === 2, `实际调用 ${calls} 次`);
    check('场景4: 正常 done', sawAgent(events, 'done'));
    check('场景4: 无"疑似卡住"提示', !sawAgent(events, 'notice', (p) => /疑似卡住|自动续推/.test(p.text || '')));
  }

  // ---- 场景 5:repeat-tool-reminder——连续相同工具+参数调用达到阈值时注入提醒 ----
  console.log('\n[场景 5] 连续相同调用应注入提醒(防原地打转)');
  {
    const { agent, events } = makeAgent();
    let calls = 0;
    // 用 todo_write 模拟"原地打转":第 1 次建计划,之后每次重复调用 list_directory(相同参数)
    agent.llm = {
      isMock: false,
      async chat() {
        calls += 1;
        if (calls === 1) {
          return { content: '', toolCalls: [{ id: 'p', name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: '目标', status: 'in_progress' }] }) }] };
        }
        if (calls <= 5) {
          // 第 2~5 次:反复调用 list_directory 同一路径
          return { content: '', toolCalls: [{ id: `l${calls}`, name: 'list_directory', arguments: JSON.stringify({ path: '/home' }) }] };
        }
        // 之后收尾(先完成计划再结束,避免续推干扰判定)
        if (calls === 6) {
          return { content: '', toolCalls: [{ id: 'f', name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: '目标', status: 'completed' }] }) }] };
        }
        return { content: '完成了', toolCalls: [] };
      }
    };
    await agent.run('重复调用测试');
    // 连续 3 次相同 list_directory 后应在下一次请求里注入提醒(steer)
    const reminderSeen = agent.getHistory().some((m) => m.role === 'user' && /已连续 \d+ 次以相同参数调用 list_directory/.test(m.content || ''));
    check('场景5: 历史中可见重复调用提醒', reminderSeen);
    check('场景5: 正常结束', sawAgent(events, 'done'));
  }

  // ---- 场景 6:concludesTurn——工具显式宣告本轮结束(注册表层透传) ----
  console.log('\n[场景 6] 工具返回 concludesTurn 应透传到执行结果');
  {
    const { ToolRegistry } = await import('../server/agent/registry.ts');
    const reg = new ToolRegistry();
    reg.register({
      name: 'finish_now',
      description: 'test',
      parameters: { type: 'object', properties: {}, required: [] },
      async run() { return { content: '收尾完成', concludesTurn: true }; }
    });
    reg.register({
      name: 'plain_tool',
      description: 'test',
      parameters: { type: 'object', properties: {}, required: [] },
      async run() { return '普通字符串结果'; }
    });
    const c1 = await reg.execute({ name: 'finish_now', args: '{}' });
    const c2 = await reg.execute({ name: 'plain_tool', args: '{}' });
    check('场景6: concludesTurn 结果透传', c1.concludesTurn === true && c1.isError === false && c1.content.includes('收尾完成'), JSON.stringify(c1));
    check('场景6: 普通字符串结果不带 concludesTurn', !('concludesTurn' in c2) && c2.isError === false, JSON.stringify(c2));
  }

  console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
