// 前缀稳定性回归测试(缓存命中率的结构性保证)
//
// 为什么要有这条测试:
//   前缀缓存的命中率**只**由「连续两次请求之间,前缀有多少字节完全相同」决定,没有参数可调。
//   能让它掉下来的,只有某一步把前缀里的某个字节改了。所以真正要守的不是"命中率数字",
//   而是这条不变量:同一会话内,后一步的请求体必须是前一步请求体的**逐字节前缀延长**。
//
//   这是 deepseek-harness 那条真实 API e2e(request-cache.e2e.ts)的**离线等价物**:
//   不依赖网络与费用,但能在任何一次改动后立刻发现"是哪一段变了"。
//
// 两个场景(第二个是关键):
//   A 短对话:system/tools 稳定、历史只追加、运行时上下文不重复追加(基本盘);
//   B 长历史压力:历史长到**曾经会触发「绝对地板折叠」**的量级,且每步都产出超大工具结果。
//     曾经的实现会在这里按「保留最近 N 条 / N 字符」的滑动窗口改写历史中段,每滑一次就把
//     该点之后的整段前缀缓存作废(实测单次作废 20k~300k token)——正是缓存命中率上不了 99%
//     的根因。所以压力场景必须断言:历史再长、结果再大,请求体仍然逐字节只追加。
//     注意:这里的窗口给足(1M),压缩水位(80%)不会触发 —— 测的是**无压缩压力**下的投影,
//     也就是"折叠绝不能由每请求重算的滑动窗口决定"这条不变量。
// 运行:node test/request-prefix-stability.test.js
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-prefix-'));

const { Agent } = await import('../server/agent/agent.ts');
const { localFs } = await import('../server/core/local-fs.ts');
const { estimateTokens, measureEnvelope } = await import('../server/agent/compact.ts');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * 跑一个场景,捕获每次请求的 wire 级三项(system / tools / messages 深拷贝)。
 * @param {object} o
 * @param {string} o.label 场景名
 * @param {string} o.root 工作区目录
 * @param {number} o.maxSteps 最多发几次请求(第 maxSteps 次返回纯文本收尾)
 * @param {number} o.resultBytes 被 read 的文件字节数(决定每次工具结果有多大)
 */
async function runScenario({ label, root, maxSteps, resultBytes }) {
  writeFileSync(path.join(root, 'big.txt'), Array.from({ length: Math.ceil(resultBytes / 80) }, (_, i) =>
    `line ${i}: ${'x'.repeat(60)}`).join('\n'));
  localFs.workspace = root;

  const calls = [];
  const agent = new Agent({ emit: () => {} });
  agent.setPermissionMode('full-access');
  agent.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake' });
  agent.llm = {
    isMock: false,
    // 声明窗口 1M:压缩水位(80%)与本用例无关,只保证"没有任何压缩路径参与"
    contextWindow: 1_000_000,
    async chat({ messages, tools }) {
      calls.push({
        system: clone(messages.find((m) => m.role === 'system')?.content),
        tools: JSON.stringify(tools ?? null),
        msgs: clone(messages)
      });
      const n = calls.length;
      if (n < maxSteps) {
        return {
          content: '',
          toolCalls: [{ id: `c${n}`, name: 'read_local_file', arguments: JSON.stringify({ path: path.join(root, 'big.txt') }) }]
        };
      }
      return { content: '完成', toolCalls: [] };
    }
  };
  await agent.run('读大文件(前缀稳定性压力场景)');
  // 峰值估算口径与 agent 的压缩水位同源(system + 工具 schema + 历史)
  const peak = calls.reduce((m, c) => {
    const toolsArr = c.tools ? JSON.parse(c.tools) : [];
    return Math.max(m, measureEnvelope(c.system, toolsArr, c.msgs).total);
  }, 0);
  return { label, calls, peak };
}

/** 四项不变量:system 稳定、tools 稳定、历史只追加、旧消息不被原地改写 */
function assertPrefixInvariants({ label, calls }) {
  console.log(`\n[${label}] 共 ${calls.length} 次请求`);
  check(`${label}:至少 2 次请求才谈得上前缀`, calls.length >= 2, `实际 ${calls.length}`);
  if (calls.length < 2) return;

  const sysDrift = calls.findIndex((c, i) => i > 0 && c.system !== calls[0].system);
  check(`${label}:system 逐字节不变(一变全丢)`, sysDrift === -1, sysDrift >= 0 ? `第 ${sysDrift + 1} 次变了` : '');

  const toolsDrift = calls.findIndex((c, i) => i > 0 && c.tools !== calls[0].tools);
  check(`${label}:tools 逐字节不变(schema 也在缓存前缀里)`, toolsDrift === -1, toolsDrift >= 0 ? `第 ${toolsDrift + 1} 次变了` : '');

  // 后一次请求的消息数组必须以前一次为**逐字节前缀**
  let bad = -1, detail = '';
  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1].msgs;
    const cur = calls[i].msgs;
    if (cur.length < prev.length) { bad = i; detail = `消息数变少了(${prev.length} → ${cur.length})`; break; }
    if (JSON.stringify(prev) !== JSON.stringify(cur.slice(0, prev.length))) {
      let idx = -1;
      for (let k = 0; k < prev.length; k++) {
        if (JSON.stringify(prev[k]) !== JSON.stringify(cur[k])) { idx = k; break; }
      }
      bad = i;
      detail = idx >= 0
        ? `第 ${i + 1} 次请求的第 ${idx} 条消息被改写(role=${prev[idx]?.role})`
        : `第 ${i + 1} 次请求的前缀与上次不一致`;
      break;
    }
  }
  check(`${label}:后一步请求以前一步为逐字节前缀`, bad === -1, detail);

  const snapshot = JSON.stringify(calls[0].msgs);
  const mutated = calls.slice(1).some((c) => JSON.stringify(c.msgs.slice(0, calls[0].msgs.length)) !== snapshot);
  check(`${label}:第一次请求的消息在后续请求里保持原样`, !mutated);

  const countCtx = (msgs) => msgs.filter((m) => typeof m.content === 'string' && m.content.includes('<runtime_context>')).length;
  const counts = calls.map((c) => countCtx(c.msgs));
  const grewEveryStep = counts.some((n, i) => i > 0 && n > counts[i - 1]);
  check(`${label}:运行时上下文不随步数线性增长`, !grewEveryStep, `各次条数=${counts.join(',')}`);
}

const rootA = mkdtempSync(path.join(tmpdir(), 'sshai-prefix-a-'));
const rootB = mkdtempSync(path.join(tmpdir(), 'sshai-prefix-b-'));

const a = await runScenario({ label: '短对话', root: rootA, maxSteps: 2, resultBytes: 200 });
assertPrefixInvariants(a);

// 压力场景:每次工具结果 ~50KB(READ_MAX_BYTES 上限),10 步 → 峰值估算远超旧「绝对地板」60k
const b = await runScenario({ label: '长历史压力', root: rootB, maxSteps: 10, resultBytes: 400_000 });
assertPrefixInvariants(b);
console.log('');
check('长历史压力:峰值估算 token 已越过旧「绝对地板」60k 触发线', b.peak > 60_000, `实际 ${b.peak}`);
check('长历史压力:每步都确实带上了超大工具结果(≥8k 字符才会进折叠候选)',
  b.calls.length > 1 && b.calls[1].msgs.some((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.length > 8_000));

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
