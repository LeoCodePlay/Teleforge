// 验证任务计划的跨轮生命周期(计划面板显示/续推的会话端依据):
// 1. foldTodos 单元:未完成的计划跨 turn/start 存活;只有"已全部完成"的计划才在下一轮
//    turn/start 作废;turn/end 从不清空(本轮跑完的清单保持可见,由前端判"全完成即隐藏")。
// 2. 跨轮续推:上一轮留下未完成计划时,新一轮发给模型的指令带上剩余计划,让模型接着做;
//    前端投影(用户气泡)仍只显示用户自己打的原文(续推块只进模型可见面)。
// 3. 已完成计划不续推:上一轮把计划做完后,新一轮历史里不带续推块,计划也被作废。
// 注意:本测试写会话历史并覆盖 <data>/sessions.json,需在临时目录里隔离运行
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-todo-'));
const { Agent } = await import('../server/agent/agent.ts');
const { foldTodos, hasOutstandingTodos } = await import('../server/agent/session.ts');
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
  // 每个场景一份全新的事件日志:同进程的多个 Agent 实例共用 DATA_DIR 里的"活动会话",
  // 不清空就会读到上一个场景留下的计划与消息(串场)。clearHistory 同时重置运行时,
  // 也就不会带上上一个实例的上下文快照缓存。
  agent.clearHistory();
  return { agent, events };
};
const ev = (type, data) => ({ type, data });
const CARRY_RE = /上一轮的任务计划尚未完成/;

async function main() {
  setupSsh();

  // ---- 场景 1:foldTodos 的跨轮规则(纯投影,不发请求) ----
  console.log('\n[场景 1] foldTodos:未完成的计划跨轮存活,已完成的计划下一轮作废');
  {
    const half = [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }];
    const allDone = [{ content: 'A', status: 'completed' }, { content: 'B', status: 'completed' }];

    const alive = foldTodos([
      ev('turn/start', { turn: 1 }),
      ev('todo/write', { todos: half }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ev('turn/start', { turn: 2 })
    ]);
    check('场景1: 未完成计划被新一轮保留', Array.isArray(alive) && alive.length === 2 && alive[1].status === 'pending', JSON.stringify(alive));
    check('场景1: hasOutstandingTodos 判定为未完成', hasOutstandingTodos(alive) === true);

    const gone = foldTodos([
      ev('turn/start', { turn: 1 }),
      ev('todo/write', { todos: allDone }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ev('turn/start', { turn: 2 })
    ]);
    check('场景1: 全完成计划在新一轮被作废', gone === null, JSON.stringify(gone));

    const readable = foldTodos([
      ev('turn/start', { turn: 1 }),
      ev('todo/write', { todos: allDone }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } })
    ]);
    check('场景1: turn/end 不清空(本轮收尾清单仍可见)', Array.isArray(readable) && readable.length === 2, JSON.stringify(readable));
    check('场景1: 全完成清单不含待办', hasOutstandingTodos(readable) === false);
    check('场景1: 空计划不算未完成', hasOutstandingTodos([]) === false && hasOutstandingTodos(null) === false);
  }

  // ---- 场景 2:上一轮没做完 -> 新一轮指令带上剩余计划,模型接着做 ----
  console.log('\n[场景 2] 未完成计划跨轮续推:新指令携带剩余项,用户气泡不带续推文本');
  {
    const { agent } = makeAgent();
    const plan = [{ content: '摸清计划面板代码', status: 'completed' }, { content: '改折叠规则', status: 'pending' }];
    let calls = 0;
    const seen = [];
    agent.llm = {
      isMock: false,
      async chat({ messages }) {
        calls += 1;
        seen.push(messages.map((m) => m.content));
        if (calls === 1) {
          return { content: '', toolCalls: [{ id: 't1', name: 'todo_write', arguments: JSON.stringify({ todos: plan }) }] };
        }
        return { content: '接着改完了', toolCalls: [] };
      }
    };
    await agent.run('建个计划做一半就停');
    check('场景2: 第一轮结束后面板仍拿到未完成计划', agent.currentTodos().length === 2, JSON.stringify(agent.currentTodos()));

    await agent.run('继续');
    // 每次请求记录当时发给模型的全部消息内容;末次请求即第二轮的上下文
    const secondCallMsgs = seen[seen.length - 1];
    const carryMsgs = secondCallMsgs.filter((c) => CARRY_RE.test(String(c)));
    check('场景2: 第二轮请求携带剩余计划', carryMsgs.length === 1, `命中 ${carryMsgs.length} 条`);
    check('场景2: 续推块列出未完成项', carryMsgs.length === 1
      && /改折叠规则/.test(String(carryMsgs[0]))
      && /还剩 1 项未做/.test(String(carryMsgs[0])), String(carryMsgs[0] || '').slice(0, 200));
    check('场景2: 续推文本并进用户本轮指令(同一条消息含"继续")', carryMsgs.length === 1
      && String(carryMsgs[0]).startsWith('继续'), String(carryMsgs[0] || '').slice(0, 60));
    // 前端投影:用户气泡只有原文,不出现续推块
    const userBubbles = agent.getHistory().filter((m) => m.role === 'user' && !/runtime_context/.test(m.content || ''));
    check('场景2: 前端用户气泡仍是原文', userBubbles.some((m) => m.content === '继续')
      && !userBubbles.some((m) => CARRY_RE.test(m.content || '')), JSON.stringify(userBubbles.map((m) => m.content)));
    check('场景2: 第二轮结束后面板仍显示该计划(未做完)', agent.currentTodos().length === 2);
  }

  // ---- 场景 3:上一轮已做完 -> 新一轮不再续推,计划作废 ----
  console.log('\n[场景 3] 已完成计划不续推,并在新一轮作废(面板据此收起)');
  {
    const { agent } = makeAgent();
    let calls = 0;
    const seen = [];
    agent.llm = {
      isMock: false,
      async chat({ messages }) {
        calls += 1;
        seen.push(messages.map((m) => m.content));
        if (calls === 1) {
          return { content: '', toolCalls: [{ id: 't1', name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: '一步做完', status: 'completed' }] }) }] };
        }
        return { content: '新的话题', toolCalls: [] };
      }
    };
    await agent.run('一件事做完');
    check('场景3: 收尾清单仍可见(全完成)', agent.currentTodos().length === 1
      && agent.currentTodos()[0].status === 'completed', JSON.stringify(agent.currentTodos()));
    await agent.run('换个话题');
    check('场景3: 第二轮请求不携带续推块', !seen[seen.length - 1].some((c) => CARRY_RE.test(String(c))),
      JSON.stringify((seen[seen.length - 1] || []).filter((c) => CARRY_RE.test(String(c))).map((c) => String(c).slice(0, 80))));
    check('场景3: 全完成计划在新一轮被作废(面板无残留)', agent.currentTodos().length === 0, JSON.stringify(agent.currentTodos()));
  }

  console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
