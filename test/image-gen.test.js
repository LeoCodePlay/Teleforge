// 生图模型(imageGen)链路测试:验证「多轮对话式生图」的路由语义与事件投影。
// 离线部分用假 LLM 记录调用,不打真实网络(确定性、可进 CI);
// 实网部分仅在显式设置 IMAGE_E2E=1 且提供 key 时运行,用于验证上游真的能出图。
// 注意:本测试写附件与会话,需在临时 DATA_DIR 里隔离运行。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-ig-'));
const { Agent, projectEvents, messageFaceIndexes } = await import('../server/agent/agent.ts');
const { saveAttachment, getAttachment, attachmentPath } = await import('../server/store/attachments-store.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

// 最小合法 1x1 PNG(假上游返回的"成图"字节)
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

// 假生图 LLM:记录每轮走的是 generations 还是 edits、带了几张参考图
function makeFakeImageLlm() {
  const calls = [];
  return {
    calls,
    isMock: false,
    model: 'fake-image-1',
    imageGen: true,
    multimodal: false,
    contextWindow: 0,
    maxTokens: 0,
    apiKey: 'k',
    baseUrl: 'http://x',
    async generateImage({ prompt }) {
      calls.push({ ep: 'generations', prompt, refs: 0 });
      return [{ buf: PNG_1X1, mime: 'image/png', size: '1024x1024', model: 'fake-image-1' }];
    },
    async editImage({ prompt, images }) {
      calls.push({ ep: 'edits', prompt, refs: images.length, names: images.map((i) => i.name) });
      return [{ buf: PNG_1X1, mime: 'image/png', size: '1024x1024', model: 'fake-image-1' }];
    },
    // 若被误当文本模型调用,直接失败:证明旁路确实生效(生图轮绝不该走 chat)
    async chat() { throw new Error('生图轮不应调用 chat()'); }
  };
}

async function uploadImage(name) {
  const meta = await saveAttachment(PNG_1X1, name, 'image/png');
  return meta;
}

async function main() {
  const events = [];
  const agent = new Agent({ emit: (e, p) => events.push([e, p]) });
  agent.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake-image-1', imageGen: true });
  const llm = makeFakeImageLlm();
  agent.llm = llm;

  const sid = agent.createSession('生图测试');
  const agent2 = agent;

  // ---------- 第 1 轮:纯文字 → 文生图 ----------
  await agent2.run('画一只戴帽子的柴犬');
  check('首轮走 generations(文生图)', llm.calls[0]?.ep === 'generations', JSON.stringify(llm.calls[0]));
  check('首轮提示词=用户原文(不注入 system/技能)', llm.calls[0]?.prompt === '画一只戴帽子的柴犬', llm.calls[0]?.prompt);
  check('首轮未调用 chat(旁路生效)', !events.some(([e, p]) => e === 'agent' && p?.event === 'tool_call'));

  let sess = agent2.session;
  let genEvents = sess.events.filter((ev) => ev.type === 'image/generated');
  check('落 1 条 image/generated 事件', genEvents.length === 1, String(genEvents.length));
  check('事件 mode=t2i', genEvents[0]?.data?.mode === 't2i', genEvents[0]?.data?.mode);
  const att0 = genEvents[0]?.data?.attachments?.[0];
  check('成图已落盘为附件', !!att0 && att0.kind === 'image', JSON.stringify(att0));
  check('成图字节真实存在且可读', !!attachmentPath(att0?.id) && fs.readFileSync(attachmentPath(att0.id)).length > 0);
  check('成图文件名可读', /^生成图-\d{8}-\d{6}\.png$/.test(att0?.name || ''), att0?.name);

  // ---------- 第 2 轮:仍只发文字 → 自动携带上一张成图做图生图 ----------
  await agent2.run('把它改成戴墨镜');
  check('次轮走 edits(自动迭代修改上一张成图)', llm.calls[1]?.ep === 'edits', JSON.stringify(llm.calls[1]));
  check('次轮携带 1 张参考图=上一轮成图', llm.calls[1]?.refs === 1, JSON.stringify(llm.calls[1]));
  const refName = llm.calls[1]?.names?.[0] || '';
  check('参考图正是上一轮生成的文件', refName === att0.name, `${refName} vs ${att0.name}`);

  // ---------- 第 3 轮:用户上传 2 张图 → 优先用上传的多张参考图 ----------
  const up1 = await uploadImage('风格参考.png');
  const up2 = await uploadImage('构图参考.png');
  await agent2.run('按这两张图的风格画一只猫', { attachments: [{ id: up1.id }, { id: up2.id }] });
  check('第三轮走 edits', llm.calls[2]?.ep === 'edits', JSON.stringify(llm.calls[2]));
  check('第三轮用上传的 2 张参考图(优先于上一张成图)', llm.calls[2]?.refs === 2, JSON.stringify(llm.calls[2]));
  check('两张上传参考图按序送出', llm.calls[2]?.names?.[0] === up1.name && llm.calls[2]?.names?.[1] === up2.name, JSON.stringify(llm.calls[2]?.names));

  // ---------- 第 4 轮:只发文件(非图片)→ 无可用参考图,回落到"迭代上一张成图" ----------
  // 设计约定:生图对话里没有"新画 or 修改"的判定器(图像端点不吃历史),
  // 因此只要会话里已有成图就继续改它;用户上传的非图片文件不能当参考图,须给出可见提示。
  const txt = await saveAttachment(Buffer.from('hello'), 'notes.txt', 'text/plain');
  events.length = 0;
  await agent2.run('随便画点什么', { attachments: [{ id: txt.id }] });
  check('非图片附件不当参考图,回落到迭代上一张成图',
    llm.calls[3]?.ep === 'edits' && llm.calls[3]?.refs === 1, JSON.stringify(llm.calls[3]));
  check('参考图不是那个 txt 文件', !(llm.calls[3]?.names || []).includes('notes.txt'), JSON.stringify(llm.calls[3]?.names));
  check('对未使用的文件给出可见提示', events.some(([e, p]) => e === 'agent' && p?.event === 'notice' && /未使用/.test(p.text || '')));

  // ---------- 事件日志完整性与投影同构 ----------
  sess = agent2.session;
  check('每轮都有配对的 turn/start 与 turn/end',
    sess.events.filter((e) => e.type === 'turn/start').length === sess.events.filter((e) => e.type === 'turn/end').length);
  check('4 轮均正常结束', sess.events.filter((e) => e.type === 'turn/end' && e.data?.reason?.kind === 'completed').length === 4);
  check('生图轮不产生任何 tool/call 事件', !sess.events.some((e) => e.type === 'tool/call'));
  const turns = projectEvents(sess.events);
  check('projectEvents 与 messageFaceIndexes 计数一致(删除/分支不错位)',
    turns.length === messageFaceIndexes(sess.events).length, `${turns.length} vs ${messageFaceIndexes(sess.events).length}`);
  check('成图轮投影为带附件的 assistant 消息',
    turns.filter((t) => t.role === 'assistant' && Array.isArray(t.attachments) && t.attachments.length).length === 4);
  check('投影出的摘要文本含通路标识',
    turns.some((t) => /文生图/.test(t.content || '')) && turns.some((t) => /图生图/.test(t.content || '')));

  // ---------- 模型历史面 ----------
  // 设计约定:image/generated 不是消息面(图像端点不吃历史,生图轮之间无模型侧上下文);
  // 但每轮刻意补一条 assistant/message 摘要,让"把本会话切回文本模型"时 AI 仍知道这里出过图。
  // 因此历史里 assistant 消息数必须恰等于生图轮数 —— 多一条即说明成图事件被错误投影了。
  const derived = sess.deriveMessages();
  const genCount = sess.events.filter((e) => e.type === 'image/generated').length;
  const derivedAssistant = derived.filter((m) => m.role === 'assistant');
  check('每条生图轮只贡献 1 条 assistant 摘要(image/generated 不额外投影)',
    derivedAssistant.length === genCount, `${derivedAssistant.length} vs ${genCount}`);
  check('assistant 摘要不携带图片字节/base64(日志轻量)',
    !derived.some((m) => /b64_json|base64,/.test(String(m.content))));
  check('deriveMessages 保留用户原话(切回文本模型仍可见需求)',
    derived.some((m) => m.role === 'user' && String(m.content).includes('戴墨镜')));

  // ---------- 失败路径:上游报错不得被自动重试、不得落空成图 ----------
  // 该轮会话里已有成图 → 实际走 edits,故两个端点都要注入失败,否则测不到真实分支
  const bad = makeFakeImageLlm();
  const boom = async () => { throw new Error('生图接口 HTTP 429 [model=x]: rate limit'); };
  bad.generateImage = boom;
  bad.editImage = boom;
  agent.llm = bad;
  events.length = 0;
  const genBefore = agent2.session.events.filter((e) => e.type === 'image/generated').length;
  await agent2.run('这张会失败');
  check('失败时发 error 事件', events.some(([e, p]) => e === 'agent' && p?.event === 'error'));
  check('失败轮 turn/end 记为 error', agent2.session.events.some((e) => e.type === 'turn/end' && e.data?.reason?.kind === 'error'));
  check('失败不落 image/generated(不产生空成图)',
    agent2.session.events.filter((e) => e.type === 'image/generated').length === genBefore, String(genBefore));
  check('上游只被调用一次(生图按张计费,绝不自动重试)',
    bad.calls.length === 0 && events.filter(([e, p]) => e === 'agent' && p?.event === 'retry').length === 0,
    `retry 事件数=${events.filter(([e, p]) => e === 'agent' && p?.event === 'retry').length}`);

  // ---------- 附件元数据防伪:未知 id 被丢弃,不得凭空增加参考图 ----------
  agent.llm = makeFakeImageLlm();
  const llm2 = agent.llm;
  await agent2.run('参考不存在的图', { attachments: [{ id: 'att_not_exist' }] });
  check('未知附件 id 被丢弃(参考图数不因伪造 id 增加)',
    llm2.calls[0]?.ep === 'edits' && llm2.calls[0]?.refs === 1, JSON.stringify(llm2.calls[0]));

  // ---------- 实网验证(可选)----------
  if (process.env.IMAGE_E2E === '1' && process.env.IMAGE_E2E_KEY) {
    console.log('\n  —— 实网验证(真实提供商)——');
    const real = new Agent({ emit: () => {} });
    real.configureLlm({
      baseUrl: process.env.IMAGE_E2E_BASE || 'https://www.fucheers.top/v1',
      apiKey: process.env.IMAGE_E2E_KEY,
      model: process.env.IMAGE_E2E_MODEL || 'gpt-image-2',
      imageGen: true
    });
    const rsid = real.createSession('实网生图');
    await real.run('一只戴红色毛线帽的柴犬,纯色背景,居中构图');
    const rEv = real.session.events.filter((e) => e.type === 'image/generated');
    check('实网:首轮文生图成功', rEv[0]?.data?.mode === 't2i', JSON.stringify(rEv[0]?.data?.mode));
    const rAtt = rEv[0]?.data?.attachments?.[0];
    const rPath = rAtt ? attachmentPath(rAtt.id) : null;
    const rBuf = rPath ? fs.readFileSync(rPath) : null;
    check('实网:成图字节为合法 PNG', !!rBuf && rBuf.readUInt32BE(0) === 0x89504e47, rBuf ? rBuf.subarray(0, 4).toString('hex') : 'no file');
    check('实网:成图尺寸>10KB(不是占位图)', (rBuf?.length || 0) > 10240, String(rBuf?.length));
    await real.run('把帽子换成蓝色');
    const rEv2 = real.session.events.filter((e) => e.type === 'image/generated');
    check('实网:次轮自动走图生图(携带上一张成图)', rEv2[1]?.data?.mode === 'i2i' && rEv2[1]?.data?.refs === 1, JSON.stringify(rEv2[1]?.data && { mode: rEv2[1].data.mode, refs: rEv2[1].data.refs }));
    console.log(`  ℹ 上游回显尺寸=${rEv2[1]?.data?.size},实际模型名=${rEv2[1]?.data?.upstreamModel}`);
    void rsid;
  }

  console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
