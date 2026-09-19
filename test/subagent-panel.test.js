// 子代理运行记录:store(落盘/列表/详情/保留策略)+ RPC(subagent_list / subagent_get)。
// 这一层是右侧面板的唯一数据来源,所以单独测:面板能不能回看,取决于这里落得全不全。
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-sa-panel-'));

const store = await import('../server/store/subagent-store.ts');
const { createRpcRouter } = await import('../server/api/rpc/router.ts');
const { AGENT, SUBAGENTS_DIR } = await import('../server/config.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

const files = () => { try { return readdirSync(SUBAGENTS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; } };

// ---- 1. 记录生命周期:begin → append → finish ----
{
  const runId = store.newRunId();
  const started = store.beginRun({
    runId, sid: 's_panel', description: '查注册链路', provider: 'internal',
    brief: { objective: '查明 subagent 的注册位置', scope: '只读 server/' },
    prompt: '【任务目标】\n查明 subagent 的注册位置', maxSteps: 12
  });
  check('newRunId 形如 sa_xxx', /^sa_[0-9a-z]+$/.test(runId), runId);
  check('beginRun 立刻是 running(面板能在跑的过程中就打开)', started.status === 'running');
  check('beginRun 立刻落盘(重启后也回看得到)', files().includes(`${runId}.json`), files().join(','));

  store.appendMessage(runId, { role: 'user', step: 0, at: Date.now(), text: '【任务目标】\n查明 subagent 的注册位置' });
  store.appendMessage(runId, { role: 'assistant', step: 1, at: Date.now(), text: '先看注册表', reasoning: '需要先定位入口' });
  store.appendMessage(runId, { role: 'tool', step: 1, at: Date.now(), callId: 'c1', name: 'search_code', args: '{"pattern":"registerTools"}', isError: false, content: 'tools.ts:1042', ms: 12 });
  store.appendMessage(runId, { role: 'assistant', step: 2, at: Date.now(), text: '结论:注册在 registerTools()。' });

  const mid = store.get(runId);
  check('详情按顺序返回四条消息', (mid?.messages || []).map((m) => m.role).join(',') === 'user,assistant,tool,assistant',
    JSON.stringify((mid?.messages || []).map((m) => m.role)));
  check('工具消息保留名字/参数/结果/耗时(面板据此渲染工具行)',
    mid?.messages[2].name === 'search_code' && mid?.messages[2].args.includes('registerTools')
    && mid?.messages[2].content === 'tools.ts:1042' && mid?.messages[2].ms === 12);
  check('思考内容单独保留', mid?.messages[1].reasoning === '需要先定位入口');
  check('brief 原样保留(回看任务与边界是怎么写的)', mid?.brief?.objective === '查明 subagent 的注册位置');

  store.finishRun(runId, { status: 'done', steps: 2, toolCalls: 1, promptTokens: 120, completionTokens: 30, hitStepLimit: false });
  const done = store.get(runId);
  check('finishRun 写状态与统计', done?.status === 'done' && done?.steps === 2 && done?.toolCalls === 1
    && done?.promptTokens === 120 && done?.completionTokens === 30, JSON.stringify({ s: done?.status, st: done?.steps }));
  check('finishRun 记耗时与结束时间', typeof done?.ms === 'number' && done?.ms >= 0 && typeof done?.endedAt === 'number');

  // 落盘内容与内存一致(重启读盘等价路径)
  const raw = JSON.parse(readFileSync(path.join(SUBAGENTS_DIR, `${runId}.json`), 'utf8'));
  check('落盘 JSON 含完整对话与状态', raw.status === 'done' && raw.messages.length === 4 && raw.runId === runId);
}

// ---- 2. 列表:按 sid 过滤 + 倒序 ----
{
  const a = store.newRunId();
  store.beginRun({ runId: a, sid: 's_A', description: 'A 的任务', provider: 'internal', brief: {}, prompt: 'x', maxSteps: 5 });
  const b = store.newRunId();
  store.beginRun({ runId: b, sid: 's_B', description: 'B 的任务', provider: 'internal', brief: {}, prompt: 'x', maxSteps: 5 });
  const listA = store.list('s_A');
  check('按 sid 过滤只返回该会话的派发', listA.length === 1 && listA[0].runId === a, JSON.stringify(listA.map((r) => r.runId)));
  check('列表不含对话正文(轻量)', listA.every((r) => !('messages' in r)));
  check('不传 sid 返回全部', store.list().length >= 3, String(store.list().length));
  const all = store.list();
  check('按开始时间倒序(最新的在最上面)',
    all.every((r, i) => i === 0 || all[i - 1].startedAt >= r.startedAt), JSON.stringify(all.map((r) => r.startedAt)));
  check('列表带面板要展示的字段', typeof all[0].steps === 'number' && typeof all[0].status === 'string' && typeof all[0].description === 'string');
}

// ---- 3. 非法 / 不存在的 id:返回 null,不抛 ----
{
  check('不存在但合法的 id → null', store.get('sa_notexist0000') === null);
  check('非法 id(路径注入)→ null 而不是抛错', store.get('../evil') === null && store.get('s_abc') === null);
  check('空 id → null', store.get('') === null);
}

// ---- 4. 保留上限:超出删最旧(内存 + 文件) ----
{
  const keep = AGENT.SUBAGENT.MAX_RUNS;
  AGENT.SUBAGENT.MAX_RUNS = 3;
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = store.newRunId();
    ids.push(id);
    store.beginRun({ runId: id, sid: 's_cap', description: `第 ${i} 个`, provider: 'internal', brief: {}, prompt: 'x', maxSteps: 5 });
  }
  const left = store.list();
  check('保留上限生效(只剩 3 条)', left.length === 3, `实际 ${left.length}`);
  check('被删的是最旧的', !left.some((r) => r.runId === ids[0]) && left.some((r) => r.runId === ids[4]),
    JSON.stringify(left.map((r) => r.runId)));
  check('文件同步删除(不占盘)', files().length === 3, `实际 ${files().length} 个文件`);
  check('被删的记录 get 返回 null', store.get(ids[0]) === null);
  AGENT.SUBAGENT.MAX_RUNS = keep;
}

// ---- 5. RPC:面板实际调用的两个接口 ----
{
  const rpc = createRpcRouter({ send() {}, emitStatus() {}, syncAgentScope() {} });
  check('subagent_list / subagent_get 已注册',
    rpc.types().includes('subagent_list') && rpc.types().includes('subagent_get'));

  const call = (type, msg) => new Promise((resolve) => {
    const sent = [];
    rpc.handle({ type, ...msg, reqId: 'r1' }, { send: (p) => sent.push(p) })
      .then(() => resolve(sent.find((p) => p.type !== undefined) || null))
      .catch((e) => resolve({ type: 'error', error: e.message }));
  });

  // 先造一条属于 s_RPC 的记录(第 4 节的保留上限已经清掉了更早的记录)
  const rpcRun = store.newRunId();
  store.beginRun({
    runId: rpcRun, sid: 's_RPC', description: 'RPC 用例', provider: 'internal',
    brief: { objective: '确认面板取数链路' }, prompt: '【任务目标】\n确认面板取数链路', maxSteps: 8
  });
  store.appendMessage(rpcRun, { role: 'user', step: 0, at: Date.now(), text: '【任务目标】\n确认面板取数链路' });
  store.finishRun(rpcRun, { status: 'done', steps: 1, toolCalls: 0, promptTokens: 10, completionTokens: 5, hitStepLimit: false });

  const listReply = await call('subagent_list', { sid: 's_RPC' });
  check('subagent_list 回 type=subagent_list + runs', listReply?.type === 'subagent_list' && Array.isArray(listReply.runs)
    && listReply.runs.length === 1, JSON.stringify(listReply)?.slice(0, 160));

  const one = store.list('s_RPC')[0];
  const getReply = await call('subagent_get', { runId: one.runId });
  check('subagent_get 回 type=subagent_run + 完整对话', getReply?.type === 'subagent_run'
    && getReply.run?.runId === one.runId && Array.isArray(getReply.run.messages), JSON.stringify(getReply)?.slice(0, 160));

  const missReply = await call('subagent_get', { runId: 'sa_notexist0000' });
  check('记录不存在时如实回 run=null(前端渲染"记录已不在")', missReply?.run === null);
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail > 0 ? 1 : 0);
