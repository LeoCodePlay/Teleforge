// 上下文水位口径回归测试(「/compact 之后仪表盘纹丝不动」):
// 起因:压缩是非破坏的——被压早期消息仍完整留在聊天里显示,模型面却只从最后一个压缩
// 标记行起。前端兜底估算若按整个渲染历史算,压缩后水位不变,看起来"压缩没生效"。
// 这组用例锁定两条不变量:
//   1) 前端兜底口径 = 模型可见面(从最后一个 compaction 标记起),与服务端 deriveMessages 对齐;
//   2) 手动压缩(不产生新的模型请求)后服务端主动广播压缩后的 context_usage,
//      仪表盘无需等下一次请求就能看到水位下降。
// 全程用假 LLM,不打真实网络;会话写入临时 DATA_DIR,不碰用户数据。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-ctxusage-'));

const { Agent } = await import('../server/agent/agent.ts');
const { measureMessages } = await import('../server/agent/compact.ts');
const { modelFaceMessages, estimateMessages, estimateBreakdown } = await import('../web/src/utils/tokens.ts');
const store = await import('../server/store/session-store.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const finish = () => { console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`); if (fail) process.exit(1); };

// ---- 1) 前端兜底口径:只算模型可见面 ----
{
  const old = [
    { role: 'user', content: '很早的问题:' + '历史内容'.repeat(200) },
    { role: 'assistant', content: '很早的回答:' + '历史内容'.repeat(200) }
  ];
  const marker = { role: 'user', content: '【上下文已手动压缩】摘要', compaction: { dropCount: 2, manual: true } };
  const recent = [
    { role: 'user', content: '最近的问题' },
    { role: 'assistant', content: '最近的回答' }
  ];
  const rendered = [...old, marker, ...recent];

  check('modelFaceMessages 从最后一个压缩标记起切', modelFaceMessages(rendered).length === 3
    && modelFaceMessages(rendered)[0] === marker, `got ${modelFaceMessages(rendered).length}`);
  check('无压缩标记时原样返回', modelFaceMessages(recent).length === 2);

  const all = estimateMessages(rendered);
  const face = estimateMessages([marker, ...recent]);
  check('estimateMessages 压缩后按模型面计(不把被压历史算进去)', all === face && all < estimateMessages(rendered.slice(0, 2)) * 2,
    `all=${all} face=${face} oldOnly=${estimateMessages(rendered.slice(0, 2))}`);

  // 多次压缩:只遵循最后一个检查点(与服务端"后一个检查点覆盖前一个"一致)
  const rendered2 = [...old, { ...marker, content: '旧摘要' }, ...recent, { role: 'user', content: '二次压缩摘要', compaction: { dropCount: 3 } }, { role: 'assistant', content: '尾' }];
  check('多次压缩只从最后一个标记起算', modelFaceMessages(rendered2).length === 2
    && modelFaceMessages(rendered2)[0].content === '二次压缩摘要', `got ${JSON.stringify(modelFaceMessages(rendered2).map((m) => m.content))}`);

  const bd = estimateBreakdown(rendered, '');
  check('estimateBreakdown 同样只算模型面', bd.system > 0 && bd.tools === 0 && bd.conversation > 0
    && bd.conversation < estimateMessages(rendered.slice(0, 2)), `got ${JSON.stringify(bd)}`);
}

// ---- 2) 服务端:手动压缩后主动广播压缩后的 context_usage ----
{
  const emitted = [];
  const a = new Agent({ emit: (event, payload) => emitted.push({ event, payload }) });
  a._systemPrompt = () => 'sys'; // 不依赖真实环境快照
  a.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake-1', contextWindow: 8000 });
  a.llm = {
    isMock: false,
    contextWindow: 8000,
    maxTokens: 1024,
    async chat() {
      return { content: '【checkpoint 摘要】目标:治理上下文;待办:验证。', toolCalls: [], reasoning: '' };
    }
  };
  a.llmConfigured = true;

  const sid = a.createSession('压缩后水位广播').id;
  const session = a._runtimes.get(sid).session;
  for (let g = 0; g < 3; g++) {
    session.append('turn/start', { turn: g + 1 });
    session.append('user/message', { content: `问题${g}:` + '请分析这个模块的实现细节并给出改造方案。'.repeat(60), source: 'user' });
    session.append('assistant/message', { turn: g + 1, step: 1, message: { role: 'assistant', content: `回答${g}:` + '实现说明与代码走读结论。'.repeat(60) } });
    session.append('turn/end', { turn: g + 1, reason: { kind: 'completed' } });
  }
  store.saveEvents(sid, session.events);

  const before = measureMessages([{ role: 'system', content: 'sys' }, ...session.deriveMessages({})]);
  const r = await a.compactNow(sid);
  check('compactNow 报告已压缩', r.compacted === true && r.dropCount > 0, `got ${JSON.stringify(r)}`);
  check('压缩后广播 history_compacted', emitted.some((e) => e.payload?.event === 'history_compacted' && e.payload?.sid === sid));

  const cu = emitted.filter((e) => e.payload?.event === 'context_usage' && e.payload?.sid === sid).pop();
  check('压缩后广播 context_usage(手动压缩不产生新请求,否则仪表盘停在旧值)', !!cu, `got ${JSON.stringify(emitted.map((e) => e.payload?.event))}`);
  if (cu) {
    check('context_usage 的 actual 为空(无真实请求,前端按预估显示)', cu.payload.actual === null);
    check('context_usage 的窗口为模型窗口', cu.payload.window === 8000, `got ${cu.payload.window}`);
    const expect = measureMessages([{ role: 'system', content: 'sys' }, ...session.deriveMessages({})]);
    check('context_usage 预估 = 压缩后的模型面(含 system)', cu.payload.estimated === expect,
      `got ${cu.payload.estimated} expect ${expect}`);
    check('压缩后水位明显下降', cu.payload.estimated < before / 2, `before=${before} after=${cu.payload.estimated}`);
  }
}

finish();
