// 子代理(in-process 只读调研代理)测试,对应 server/agent/subagent.ts 与 tools.ts 的 subagent 工具:
// - 提示词契约:任务/边界必须由父对话自己写清(prompt 或 objective+scope 二选一),写不清在源头被挡下;
// - 只读边界:白名单外工具不派发,回结构化错误让子代理改方案(而不是终结子代理);
// - 上下文隔离:子代理只看得到自己的提示词,看不到父会话历史;
// - 过程隔离:父会话只多一条 tool/call + tool/result,中间步骤不回传、可回放;
// - 停止:父轮中止立即传播;不设步数上限,模型不再发起工具调用即自然收敛;
// - 提供商:默认且唯一 internal(本项目内置 agent),外部 agent 明确拒绝、不冒充;
// - 注册与权限:subagent 已注册、声明 write、mutating(并行池独占)。
// 说明:ESM 静态 import 先于代码执行,故用顶层 await 在导入 agent 前设置 DATA_DIR
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-sub-'));

const { Agent, toolRegistry } = await import('../server/agent/agent.ts');
const { runSubagent, SUBAGENT_TOOLS, SUBAGENT_PROVIDERS, composeSubagentPrompt } = await import('../server/agent/subagent.ts');
const saStore = await import('../server/store/subagent-store.ts');
const { localFs } = await import('../server/core/local-fs.ts');
const { loadEvents } = await import('../server/store/session-store.ts');
const { AGENT } = await import('../server/config.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const root = mkdtempSync(path.join(tmpdir(), 'sshai-sub-ws-'));
localFs.workspace = root;
writeFileSync(path.join(root, 'note.txt'), 'hello');

// 合法派发的最小字段(测试里复用;真实场景由父对话自己写)
const BRIEF = { objective: '列出工作区目录并确认 note.txt 是否存在', scope: '只读本机工作区;不要写文件、不要执行命令' };

// 校验一份投影消息序列严格"工具配对完整"(tool 消息必须紧跟声明它的 assistant tool_calls)
function pairingOk(msgs) {
  let pending = new Set();
  for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) pending = new Set(m.tool_calls.map((t) => t.id));
    else if (m.role === 'tool') {
      if (!pending.has(m.tool_call_id)) return false;
      pending.delete(m.tool_call_id);
    }
  }
  return true;
}

async function main() {
  // ---- 1. 注册与权限声明 ----
  {
    const def = toolRegistry.get('subagent');
    check('subagent 已注册', !!def);
    check('subagent 声明为 write(confirm 下审批 / plan 下拒绝)', def?.access === 'write', String(def?.access));
    check('subagent 为 mutating(并行池独占,不与其它工具并发)', def?.mutating === true);
    check('subagent 未声明并发安全', toolRegistry.isConcurrencySafe('subagent') === false);
    check('子代理不能再派生子代理(白名单不含 subagent,杜绝递归)', !SUBAGENT_TOOLS.has('subagent'));
    check('白名单含只读工具、不含写/命令工具',
      SUBAGENT_TOOLS.has('read_file') && SUBAGENT_TOOLS.has('list_local_dir')
      && !SUBAGENT_TOOLS.has('write_file') && !SUBAGENT_TOOLS.has('run_command') && !SUBAGENT_TOOLS.has('write_local_file'));
  }

  // ---- 1b. 提供商与提示词契约(schema 层面) ----
  {
    const def = toolRegistry.get('subagent');
    const props = def?.parameters?.properties || {};
    check('provider 只有 internal(不接外部 agent)', SUBAGENT_PROVIDERS.length === 1 && SUBAGENT_PROVIDERS[0] === 'internal');
    check('工具 schema 暴露 provider 且枚举只有 internal',
      JSON.stringify(props.provider?.enum) === JSON.stringify(['internal']), JSON.stringify(props.provider?.enum));
    check('工具 schema 暴露任务/边界字段(objective/scope/deliverable/context)',
      ['objective', 'scope', 'deliverable', 'context'].every((k) => props[k]?.type === 'string'));
    check('JSON Schema 只强制 description(任务/边界由 composeSubagentPrompt 把关)',
      JSON.stringify(def?.parameters?.required) === JSON.stringify(['description']), JSON.stringify(def?.parameters?.required));
    check('契约阈值来自配置且为正数',
      AGENT.SUBAGENT.MIN_PROMPT_CHARS > 0 && AGENT.SUBAGENT.MIN_FIELD_CHARS > 0,
      `${AGENT.SUBAGENT.MIN_PROMPT_CHARS}/${AGENT.SUBAGENT.MIN_FIELD_CHARS}`);
  }

  // ---- 1c. 组装与校验:内容来自父对话,工具只做标注与拼接 ----
  {
    const longPrompt = '你是只读调研员:' + 'x'.repeat(AGENT.SUBAGENT.MIN_PROMPT_CHARS);
    check('只给足够长的 prompt:原样下发(不加壳)', composeSubagentPrompt({ prompt: longPrompt }) === longPrompt);

    const composed = composeSubagentPrompt({
      objective: '查明 subagent 工具的注册位置',
      scope: '只读 server/;不要改文件、不要执行命令',
      deliverable: '结论 + 证据(文件:行号)',
      context: '已知入口:server/agent/tools.ts'
    });
    const order = ['【任务目标】', '【边界(必须遵守)】', '【回传要求】', '【已知线索'];
    check('结构化字段按固定顺序标注拼接',
      order.every((k) => composed.includes(k))
      && order.map((k) => composed.indexOf(k)).every((v, i, a) => i === 0 || a[i - 1] < v),
      composed.slice(0, 200));
    check('拼接结果带着父对话写的原文', composed.includes('查明 subagent 工具的注册位置') && composed.includes('只读 server/'));

    let vague = '';
    try { composeSubagentPrompt({ objective: '查一下' }); } catch (e) { vague = e.message; }
    check('只给过短的 objective(缺边界)被挡下', /请先自己写清/.test(vague) && /scope/.test(vague), vague);
    check('拒绝信息给出可照抄的模板', /objective:/.test(vague) && /scope:/.test(vague) && /deliverable:/.test(vague), vague.slice(0, 200));
    check('拒绝信息点明两条合法路径', /prompt/.test(vague) && new RegExp(String(AGENT.SUBAGENT.MIN_PROMPT_CHARS)).test(vague), vague.slice(0, 240));
  }

  // ---- 2. 只读边界:白名单外工具不派发,子代理能拿到错误结果并改方案 ----
  {
    const seen = [];
    let n = 0;
    const llm = {
      isMock: false,
      async chat({ messages }) {
        seen.push(messages);
        n += 1;
        if (n === 1) {
          return {
            content: '',
            toolCalls: [
              { id: 'w1', name: 'write_local_file', arguments: JSON.stringify({ path: path.join(root, 'hack.txt'), content: 'x' }) },
              { id: 'c1', name: 'run_local_command', arguments: JSON.stringify({ command: 'echo hi' }) }
            ]
          };
        }
        return { content: '结论:写操作被拒,改由主代理执行。', toolCalls: [] };
      }
    };
    const r = await runSubagent({
      llm, registry: toolRegistry, description: '改文件', sid: 's1',
      objective: '把 note.txt 改名(definitely-not-allowed)', scope: '只读;不要写文件、不要执行命令'
    });
    const firstPrompt = String(seen[0]?.[1]?.content || '');
    check('下发给子代理的提示词含【任务目标】与【边界】(父对话自己写的)', firstPrompt.includes('【任务目标】') && firstPrompt.includes('【边界(必须遵守)】'), firstPrompt.slice(0, 160));
    check('白名单外的写工具未被真实执行(未落盘)', !existsSync(path.join(root, 'hack.txt')));
    check('两次工具调用都被记为调用次数', r.toolCalls === 2, `实际 ${r.toolCalls}`);
    const fedBack = JSON.stringify(seen[1] || []);
    check('拒绝理由已回喂给子代理(两条)', (fedBack.match(/不允许调用工具/g) || []).length === 2, fedBack.slice(0, 200));
    check('子代理仍能给出最终结论(单个工具失败不终结子代理)', r.content.includes('写操作被拒'), r.content.slice(0, 120));
    check('回传内容就是结论本身(不带步数/调用数等过程元信息)', !/步 ·|次工具调用|token/.test(r.content), r.content.slice(0, 120));
    check('结果标记 provider=internal(本项目内置 agent)', r.provider === 'internal', String(r.provider));
  }

  // ---- 3. 白名单内的只读工具确实可执行 ----
  {
    const seen = [];
    let n = 0;
    const llm = {
      isMock: false,
      async chat({ messages }) {
        seen.push(messages);
        n += 1;
        if (n === 1) return { content: '', toolCalls: [{ id: 'r1', name: 'list_local_dir', arguments: JSON.stringify({ path: root }) }] };
        return { content: '结论:目录里有 note.txt', toolCalls: [] };
      }
    };
    const r = await runSubagent({ llm, registry: toolRegistry, sid: 's1', ...BRIEF });
    const toolMsg = (seen[1] || []).filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
    check('只读工具真实执行(home 目录列表回喂给子代理)', !/不允许调用工具/.test(toolMsg) && toolMsg.includes('note.txt'), toolMsg.slice(0, 200));
    check('结论被回传', r.content.includes('目录里有 note.txt'));
  }

  // ---- 4. 不设步数上限:跑到模型自己收尾 ----
  {
    let n = 0;
    const llm = {
      isMock: false,
      async chat() {
        n += 1;
        if (n <= 30) return { content: `第 ${n} 步`, toolCalls: [{ id: `x${n}`, name: 'list_local_dir', arguments: JSON.stringify({ path: root }) }] };
        return { content: '结论:30 步后自然收敛', toolCalls: [] };
      }
    };
    const r = await runSubagent({ llm, registry: toolRegistry, ...BRIEF });
    check('超过旧的 24 步上限仍然继续(不设步数上限)', n === 31, `实际 ${n}`);
    check('模型不再发起工具调用即收敛', r.content.includes('30 步后自然收敛'), r.content.slice(0, 160));
    check('结果里不再有步数上限字段', r.hitStepLimit === undefined, String(r.hitStepLimit));
    check('回传内容不含步数/调用数元信息', !/步 ·|次工具调用|token/.test(r.content), r.content.slice(0, 160));
  }

  // ---- 5. 停止传播 + 参数校验 + 提供商 ----
  {
    const ac = new AbortController();
    ac.abort();
    let stopped = '';
    try {
      await runSubagent({ llm: { chat: async () => ({ content: '', toolCalls: [] }) }, registry: toolRegistry, ...BRIEF, signal: ac.signal });
    } catch (e) { stopped = e.message; }
    check('父轮中止立即传播(抛"已停止")', stopped === '已停止', stopped);
    check('中止的记录状态为 stopped(不是永远挂着 running)',
      saStore.list().some((r) => r.status === 'stopped'), JSON.stringify(saStore.list().map((r) => r.status)));

    let empty = '';
    try { await runSubagent({ llm: { chat: async () => ({ content: '', toolCalls: [] }) }, registry: toolRegistry }); }
    catch (e) { empty = e.message; }
    check('什么都没写直接被拒(提示要写清任务与边界)', /请先自己写清/.test(empty) && /objective/.test(empty) && /scope/.test(empty), empty);

    // 提供商:默认 internal,外部 agent 明确拒绝(不悄悄换别的执行方式)
    let ran = 0;
    const spyLlm = { chat: async () => { ran += 1; return { content: '不该被调用', toolCalls: [] }; } };
    let rejected = '';
    try {
      await runSubagent({ llm: spyLlm, registry: toolRegistry, ...BRIEF, provider: 'claude-code' });
    } catch (e) { rejected = e.message; }
    check('传外部 provider 直接报错(未接入)', /未接入外部 agent 提供商/.test(rejected), rejected);
    check('被拒绝时没有真的跑子代理(模型 0 次调用)', ran === 0, `实际 ${ran}`);
    check('被拒绝时不产生运行记录(面板不会出现空壳)', !saStore.list().some((r) => r.description === '' && r.steps === 0 && r.status === 'running'));
    check('错误里点名当前只能用内置 agent', /内置 agent/.test(rejected) && /不要用其它方式冒充/.test(rejected), rejected);

    let n = 0;
    const okLlm = { chat: async () => { n += 1; return { content: '结论:OK', toolCalls: [] }; } };
    const explicit = await runSubagent({ llm: okLlm, registry: toolRegistry, ...BRIEF, provider: 'internal' });
    const implicit = await runSubagent({ llm: okLlm, registry: toolRegistry, ...BRIEF });
    check('provider=internal 与省略都走内部 agent', explicit.provider === 'internal' && implicit.provider === 'internal' && n === 2, `n=${n}`);
  }

  // ---- 6. 端到端:父代理调用 subagent,父会话只留一条结果,历史可回放 ----
  {
    const agent = new Agent({ emit: () => {} });
    agent.setPermissionMode('full-access');
    agent.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake' });
    let parentCalls = 0, subCalls = 0;
    const subFirstMessages = [];
    agent.llm = {
      isMock: false,
      async chat({ messages }) {
        const isSubagent = messages.some((m) => m.role === 'system' && String(m.content).includes('你是一个子代理'));
        if (isSubagent) {
          subCalls += 1;
          subFirstMessages.push(messages);
          if (subCalls === 1) {
            return {
              content: 'SUBAGENT-INTERMEDIATE-THOUGHT',
              toolCalls: [{ id: 's1', name: 'list_local_dir', arguments: JSON.stringify({ path: root }) }]
            };
          }
          return { content: '子代理结论:工作区里有 note.txt。', toolCalls: [] };
        }
        parentCalls += 1;
        if (parentCalls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'p1', name: 'subagent',
              arguments: JSON.stringify({
                description: '看目录',
                objective: 'PARENT-OBJECTIVE-MARKER 列出工作区目录并确认 note.txt',
                scope: 'PARENT-SCOPE-MARKER 只读本机工作区;不要写文件、不要执行命令',
                deliverable: '结论 + 证据',
                context: '已知 note.txt 在根目录'
              })
            }]
          };
        }
        return { content: '父代理:收到子代理结论。', toolCalls: [] };
      }
    };

    await agent.run('派个子代理去看看工作区');
    const history = agent.history;
    const toolMsgs = history.slice(history.findIndex((m) => m.role === 'user' && String(m.content).includes('派个子代理'))).filter((m) => m.role === 'tool');
    const subPrompt = String(subFirstMessages[0]?.[1]?.content || '');

    check('父会话只多一条 tool 消息(子代理过程不回传)', toolMsgs.length === 1, `实际 ${toolMsgs.length}`);
    check('该结果是子代理的最终结论', String(toolMsgs[0]?.content).includes('子代理结论:工作区里有 note.txt'), String(toolMsgs[0]?.content).slice(0, 160));
    check('父会话历史里没有子代理的中间思考', !JSON.stringify(history).includes('SUBAGENT-INTERMEDIATE-THOUGHT'));
    check('子代理上下文隔离(第一次请求只有 system + 本次提示词)', subFirstMessages[0]?.length === 2, `实际 ${subFirstMessages[0]?.length}`);
    check('子代理只看得到父对话生成的提示词(不含父会话用户消息)',
      subFirstMessages[0]?.length === 2 && !JSON.stringify(subFirstMessages[0]).includes('派个子代理去看看工作区'), subPrompt.slice(0, 120));
    check('端到端提示词确实由父对话字段组装(任务/边界/回传/线索齐备)',
      subPrompt.includes('PARENT-OBJECTIVE-MARKER') && subPrompt.includes('PARENT-SCOPE-MARKER')
      && subPrompt.includes('【任务目标】') && subPrompt.includes('【边界(必须遵守)】')
      && subPrompt.includes('【回传要求】') && subPrompt.includes('【已知线索'), subPrompt.slice(0, 220));
    check('父会话投影消息序列工具配对完整(可回放)', pairingOk(history));

    const events = loadEvents(agent.getSessionId());
    const subCall = events.filter((e) => e.type === 'tool/call' && e.data?.name === 'subagent');
    const subResult = events.filter((e) => e.type === 'tool/result' && e.data?.name === 'subagent');
    check('事件日志里恰好一条 subagent tool/call', subCall.length === 1, `实际 ${subCall.length}`);
    check('事件日志里恰好一条 subagent tool/result', subResult.length === 1, `实际 ${subResult.length}`);
    check('tool/result 携带结构化 meta(步数/调用数)', subResult[0]?.data?.meta?.subagent?.steps === 2 && subResult[0]?.data?.meta?.subagent?.toolCalls === 1,
      JSON.stringify(subResult[0]?.data?.meta));
    check('父会话事件日志里没有子代理的事件(独立会话)', !events.some((e) => e.data?.source === 'subagent'));

    // 运行记录:父会话只留一条结论,但这次派发的完整过程要能在右侧面板回看
    const saMeta = subResult[0]?.data?.meta?.subagent;
    check('tool/result 的 meta 带 runId(卡片据此打开面板)', /^sa_[0-9a-z]+$/.test(String(saMeta?.runId || '')), String(saMeta?.runId));
    const rec = saStore.get(String(saMeta.runId));
    check('运行记录已落盘且状态为 done', rec?.status === 'done', String(rec?.status));
    check('记录归属当前父会话(sid 过滤据此生效)', rec?.sid === agent.getSessionId(), String(rec?.sid));
    check('记录里能看到完整过程(user → assistant → tool → assistant)',
      (rec?.messages || []).map((m) => m.role).join(',') === 'user,assistant,tool,assistant',
      JSON.stringify((rec?.messages || []).map((m) => m.role)));
    check('记录首条是父对话生成的提示词(带任务/边界标签)',
      String(rec?.messages?.[0]?.text || '').includes('PARENT-OBJECTIVE-MARKER')
      && String(rec?.messages?.[0]?.text || '').includes('【边界(必须遵守)】'));
    check('记录里的工具消息带名字与结果(面板渲染工具行)',
      rec?.messages?.[2]?.name === 'list_local_dir' && String(rec?.messages?.[2]?.content || '').includes('note.txt'));
    check('记录的统计与回传一致', rec?.steps === 2 && rec?.toolCalls === 1, JSON.stringify({ s: rec?.steps, c: rec?.toolCalls }));
    check('列表能按 sid 找到它', saStore.list(agent.getSessionId()).some((r) => r.runId === saMeta.runId));
  }

  console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
