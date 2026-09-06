// 验证对话循环的停止语义(照搬 deepseek-harness agent-loop):
// 1. 模型返回 0 个 tool_calls 即本轮结束(completed)——即使 todo 计划仍有未完成项,
//    宿主也不再注入 goal_round 续推消息(任务推进由提示词规则约束,不由宿主强跑)。
// 2. 输出因 max_tokens 被截断(finishReason='length')-> 本轮结束,结束原因为 max-tokens
//    (harness 粘性语义:截断步骤不得被当作正常完成),是否继续由用户决定。
// 3. todo 全部 completed -> 正常结束。
// 4. 运行时上下文快照:首轮请求前历史含 <runtime_context> user 消息,内容未变化时不重复追加。
// 5. repeat-tool-reminder:连续相同工具+参数调用达到阈值时注入提醒。
// 6. concludesTurn:工具显式宣告本轮结束(注册表层透传)。
// 注意:本测试写会话历史并覆盖 <data>/sessions.json,需在临时目录里隔离运行
// 说明:ESM 静态 import 先于代码执行,故用顶层 await 在导入 agent 前设置 DATA_DIR
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
const lastTurnEndReason = (agent) => {
  const ends = agent.session.events.filter((e) => e.type === 'turn/end');
  return ends.length ? ends[ends.length - 1].data.reason : null;
};

async function main() {
  setupSsh();

  // ---- 场景 1:模型宣称完成但 todo 未完成 -> 本轮直接结束(不自动续推,对齐 harness) ----
  console.log('\n[场景 1] todo 未完成即宣称完成,应直接结束而不续推');
  {
    const { agent, events } = makeAgent();
    let calls = 0;
    const plan = [
      { content: '步骤一', status: 'completed' },
      { content: '步骤二', status: 'pending' }
    ];
    agent.llm = {
      isMock: false,
      async chat({ messages }) {
        calls += 1;
        if (calls === 1) {
          return { content: '', toolCalls: [{ id: 't1', name: 'todo_write', arguments: JSON.stringify({ todos: plan }) }] };
        }
        // 模型"偷懒"只给文字:宿主不注入续推,本轮就此结束
        const hasGoalRound = messages.some((m) => m.role === 'user' && String(m.content).includes('<goal_round>'));
        check('场景1: 请求中从未出现 goal_round 注入', !hasGoalRound);
        return { content: '第一步看过了', toolCalls: [] };
      }
    };
    await agent.run('帮我完成一个多步任务');
    check('场景1: 无续推,模型只被请求 2 次', calls === 2, `实际调用 ${calls} 次`);
    check('场景1: 正常 done(iters=2)', sawAgent(events, 'done') && doneIters(events) === 2, `iters=${doneIters(events)}`);
    check('场景1: 无自动续推 notice', !sawAgent(events, 'notice', (p) => /自动续推/.test(p.text || '')));
    check('场景1: 结束原因为 completed', lastTurnEndReason(agent)?.kind === 'completed', JSON.stringify(lastTurnEndReason(agent)));
    check('场景1: 最终文本为末轮正文', doneText(events) === '第一步看过了');
  }

  // ---- 场景 2:输出被截断(finishReason=length)-> 本轮结束,原因 max-tokens(粘性) ----
  console.log('\n[场景 2] max_tokens 截断应以 max-tokens 结束,不自动续推');
  {
    const { agent, events } = makeAgent();
    let calls = 0;
    agent.llm = {
      isMock: false,
      async chat() {
        calls += 1;
        return { content: '输出到一半被截断', toolCalls: [], finishReason: 'length' };
      }
    };
    await agent.run('一个问题');
    check('场景2: 截断后未继续请求模型(本轮结束)', calls === 1, `实际调用 ${calls} 次`);
    check('场景2: 有截断提示 notice', sawAgent(events, 'notice', (p) => /截断/.test(p.text || '')));
    check('场景2: 结束原因为 max-tokens', lastTurnEndReason(agent)?.kind === 'max-tokens', JSON.stringify(lastTurnEndReason(agent)));
    check('场景2: 仍 emit done(正常收尾而非报错)', sawAgent(events, 'done'));
  }

  // ---- 场景 3:todo 全部 completed -> 正常结束 ----
  console.log('\n[场景 3] todo 全部 completed 应正常结束');
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
    check('场景3: 未触发续推', calls === 2, `实际调用 ${calls} 次`);
    check('场景3: 正常 done', sawAgent(events, 'done'));
    check('场景3: 结束原因为 completed', lastTurnEndReason(agent)?.kind === 'completed');
  }

  // ---- 场景 4:运行时上下文快照(对齐 harness runtime-context:变化才发) ----
  console.log('\n[场景 4] 运行时上下文作为 user 快照消息注入,内容未变不重复');
  {
    const { agent } = makeAgent();
    let calls = 0;
    let contextCountAtCall = [];
    agent.llm = {
      isMock: false,
      async chat({ messages }) {
        calls += 1;
        contextCountAtCall.push(messages.filter((m) => m.role === 'user' && String(m.content).includes('<runtime_context>')).length);
        if (calls === 1) {
          return { content: '', toolCalls: [{ id: 'w', name: 'list_directory', arguments: JSON.stringify({ path: '/home' }) }] };
        }
        return { content: '看过了', toolCalls: [] };
      }
    };
    await agent.run('看一下目录');
    check('场景4: 首次请求前历史含 1 条运行时上下文快照', contextCountAtCall[0] === 1, `got ${contextCountAtCall[0]}`);
    // 快照全文在事件日志里(getHistory 对带 display 的消息投影显示文本)
    const ctxMsgs = agent.session.events.filter((e) => e.type === 'user/message' && e.data?.source === 'runtime');
    check('场景4: 快照带工作区信息', ctxMsgs.some((e) => /远程工作区: \/home/.test(String(e.data?.content || ''))));
    // 同一轮内环境未变化 -> 第二次请求仍是同一条快照
    check('场景4: 未变化时不重复追加', contextCountAtCall[1] === 1, `got ${contextCountAtCall[1]}`);
  }

  // ---- 场景 5:repeat-tool-reminder——连续相同工具+参数调用达到阈值时注入提醒 ----
  console.log('\n[场景 5] 连续相同调用应注入提醒(防原地打转)');
  {
    const { agent, events } = makeAgent();
    let calls = 0;
    agent.llm = {
      isMock: false,
      async chat() {
        calls += 1;
        if (calls <= 5) {
          // 反复调用 list_directory 同一路径(达到阈值 3 后应注入提醒)
          return { content: '', toolCalls: [{ id: `l${calls}`, name: 'list_directory', arguments: JSON.stringify({ path: '/home' }) }] };
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
