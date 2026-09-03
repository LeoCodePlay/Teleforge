// 验证多条工具调用可并行执行( agent-loop 的 bounded rolling pool):
// - 并行模式:同一 assistant 消息的多个 tool_calls 并发执行,但结果按模型请求顺序提交,
//   保证 tool/result 与 assistant 消息严格配对、历史可回放;
// - 并发上限:并行工具数不超过 AGENT.MAX_PARALLEL_TOOL_CALLS;
// - 串行回退:AGENT.CONCURRENT_TOOL_CALLS=false 时逐条执行(最多 1 个在飞)。
// 说明:ESM 静态 import 先于代码执行,故用顶层 await 在导入 agent 前设置 DATA_DIR
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-para-'));
const { Agent } = await import('../server/agent/agent.ts');
const { toolRegistry } = await import('../server/agent/agent.ts');
const { AGENT } = await import('../server/config.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

// 并发观测:test_slow 工具启动/结束时更新共享计数,记录最大并发数
let running = 0, maxRunning = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const registerSlowTool = () => toolRegistry.register({
  name: 'test_slow',
  description: 'test',
  parameters: { type: 'object', properties: { name: { type: 'string' }, ms: { type: 'integer' } }, required: ['name', 'ms'] },
  async run({ name, ms }) {
    running++; maxRunning = Math.max(maxRunning, running);
    await sleep(ms);
    running--;
    return `done-${name}`;
  }
});

// 假 LLM:第 1 次调用返回多条 tool_calls(按模型顺序),之后不再调工具
function makeFakeLlm(toolCalls) {
  let calls = 0;
  return {
    isMock: false,
    async chat() {
      calls += 1;
      if (calls === 1) return { content: '', toolCalls };
      return { content: '完成', toolCalls: [] };
    }
  };
}

function makeAgent() {
  const a = new Agent({ emit: () => {} });
  a.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake' });
  return a;
}

// 每个新 Agent 会从持久化恢复同一活跃会话,历史会跨场景累积;故用
// "本轮新增消息"切片隔离断言(本轮从 user 消息起,新增部分只含本场景工具)。
const runAndToolMsgs = async (a, text) => {
  const before = a.history.length;
  await a.run(text);
  return a.history.slice(before).filter((m) => m.role === 'tool');
};

async function main() {
  // ---- 场景 A:并行 + 乱序完成,结果按模型顺序提交 ----
  {
    running = 0; maxRunning = 0;
    const unregister = registerSlowTool();
    const a = makeAgent();
    a.llm = makeFakeLlm([
      { id: 'a', name: 'test_slow', arguments: JSON.stringify({ name: 'A', ms: 50 }) },
      { id: 'b', name: 'test_slow', arguments: JSON.stringify({ name: 'B', ms: 10 }) },
      { id: 'c', name: 'test_slow', arguments: JSON.stringify({ name: 'C', ms: 30 }) }
    ]);
    const tools = await runAndToolMsgs(a, '并行跑三条命令');
    check('场景A: 多个工具确实并行执行(maxRunning=3)', maxRunning === 3, `实际 maxRunning=${maxRunning}`);
    check('场景A: 结果按模型顺序提交(A,B,C)', JSON.stringify(tools.map((m) => String(m.content))) === JSON.stringify(['done-A', 'done-B', 'done-C']), JSON.stringify(tools.map((m) => m.content)));
    check('场景A: 3 条 tool 结果齐全', tools.length === 3, `实际 ${tools.length}`);
    unregister();
  }

  // ---- 场景 B:并发上限受 MAX_PARALLEL_TOOL_CALLS 约束 ----
  {
    running = 0; maxRunning = 0;
    const oldMax = AGENT.MAX_PARALLEL_TOOL_CALLS;
    AGENT.MAX_PARALLEL_TOOL_CALLS = 2;
    const unregister = registerSlowTool();
    const a = makeAgent();
    a.llm = makeFakeLlm([1, 2, 3, 4].map((i) => ({
      id: `t${i}`, name: 'test_slow', arguments: JSON.stringify({ name: `T${i}`, ms: 40 })
    })));
    const tools = await runAndToolMsgs(a, '四条命令限制并发 2');
    check('场景B: 并发被限制在 2 内(maxRunning=2)', maxRunning === 2, `实际 maxRunning=${maxRunning}`);
    check('场景B: 4 条结果都拿到且按序', tools.length === 4 && JSON.stringify(tools.map((m) => String(m.content))) === JSON.stringify(['done-T1', 'done-T2', 'done-T3', 'done-T4']), JSON.stringify(tools.map((m) => m.content)));
    unregister();
    AGENT.MAX_PARALLEL_TOOL_CALLS = oldMax;
  }

  // ---- 场景 C:串行回退(开关关闭时逐条执行) ----
  {
    running = 0; maxRunning = 0;
    const oldFlag = AGENT.CONCURRENT_TOOL_CALLS;
    AGENT.CONCURRENT_TOOL_CALLS = false;
    const unregister = registerSlowTool();
    const a = makeAgent();
    a.llm = makeFakeLlm([
      { id: 'x', name: 'test_slow', arguments: JSON.stringify({ name: 'X', ms: 30 }) },
      { id: 'y', name: 'test_slow', arguments: JSON.stringify({ name: 'Y', ms: 10 }) },
      { id: 'z', name: 'test_slow', arguments: JSON.stringify({ name: 'Z', ms: 20 }) }
    ]);
    const tools = await runAndToolMsgs(a, '串行执行三条');
    check('场景C: 串行模式下从不并发(maxRunning=1)', maxRunning === 1, `实际 maxRunning=${maxRunning}`);
    check('场景C: 结果仍按模型顺序提交(X,Y,Z)', JSON.stringify(tools.map((m) => String(m.content))) === JSON.stringify(['done-X', 'done-Y', 'done-Z']), JSON.stringify(tools.map((m) => m.content)));
    unregister();
    AGENT.CONCURRENT_TOOL_CALLS = oldFlag;
  }

  console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
