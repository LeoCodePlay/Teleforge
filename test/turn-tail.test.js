// 一轮(Turn)的收尾段判定 + 历史投影口径(对齐 dsh 的 turn-tail)
//
// 背景(用户报的现象):同一轮里模型先给了一段回复(这一步改了 6 个文件),随后**轮内**送达
// 一条子代理结算通知(它属于正在跑的这一轮,不是新一轮),服务端此刻另起一条 assistant 行
// 承接后续步骤。早期实现让每一段各自长出收尾产物,于是界面上出现了两套「N 个文件已更改 +
// 复制/分支」,而且紧贴在"子任务状态更新"通知行下面 —— 看着像这一轮已经收工,其实还在跑。
//
// dsh 的口径:turn-tail 节点挂在该 Turn 末尾,只在 turn/end 时发布(`publication` 只在
// turn/end 返回 'immediate')—— **整轮只有一处收尾产物**,且一定出现在这一轮真正结束之后。
// 这里钉死三件事,任何一条错了都会在界面上表现为"收尾产物时机不对":
//   1. 轮边界:真实用户消息与**轮首**通知行开启新轮;轮内送达(inline)的通知行不是;
//   2. 中间片段:同一轮里后面还有 assistant 段的段是中间片段(收尾产物静默);
//   3. 历史投影:文件变更按**整轮**汇总,且只挂收尾段(中间段一个字段都不挂)。
// 运行:node test/turn-tail.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { planTurnFold, fragmentIndexes, startsNewTurn, turnAssistantIndexes, turnStartIndex } from '../web/src/utils/turnTail.ts';
import { isRealUserRow } from '../web/src/utils/compactionOrder.ts';
import { mergeAttachments, mergeDeliverables } from '../web/src/utils/mergeAttachments.ts';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const user = { role: 'user', content: '改一下 narrate 标志' };
const laterUser = { role: 'user', content: '再补一个用例' };
const a1 = { role: 'assistant', segments: [{ kind: 'text', text: '找到根因:…' }] };
const a2 = { role: 'assistant', segments: [{ kind: 'text', text: '继续接线' }] };
const retryRow = { role: 'notice', retry: { retry: 1, state: 'started', error: 'boom', maxRetries: 10, delayMs: 0 } };
// 轮内送达的通知行(server 的 deliverNotice → steer_message;投影带 inline 标记)
const inlineNotice = {
  role: 'user', content: '后台子代理 sa_x 已完成;除非你再给它发消息,它不会再做任何事。',
  source: { kind: 'subagent-settled', form: 'notice', summary: '后台子代理 sa_x 已完成' }, inline: true
};
// 轮首送达的通知行(会话空闲时唤醒它自己开一轮,dsh 的 turn-trigger)
const turnHeadNotice = {
  role: 'user', content: '后台子代理 sa_x 已完成;除非你再给它发消息,它不会再做任何事。',
  source: { kind: 'subagent-settled', form: 'notice', summary: '后台子代理 sa_x 已完成' }
};

console.log('\n[一] 轮边界判定');
check('用户消息开启新轮', startsNewTurn(user) === true);
check('轮首送达的通知行开启新轮(它触发了这一轮)', startsNewTurn(turnHeadNotice) === true);
check('轮内送达的通知行不开启新轮(它属于正在跑的这一轮)', startsNewTurn(inlineNotice) === false);
check('压缩标记行不开启新轮', startsNewTurn({ role: 'user', compaction: { dropCount: 3 } }) === false);
check('斜杠命令卡不开启新轮', startsNewTurn({ role: 'user', command: { name: 'compact', state: 'ok' } }) === false);
check('assistant 行不开启新轮', startsNewTurn(a1) === false);
check('空行不开启新轮', startsNewTurn(undefined) === false);

console.log('\n[二] 中间片段 / 本轮各段');
{
  const segs = [user, a1, inlineNotice, a2];
  const frag = fragmentIndexes(segs);
  check('轮内通知拆出的前一段是中间片段', frag.has(1) && !frag.has(3), [...frag].join(','));
  check('轮内通知之后的段是收尾段(仍显示收尾产物)', !frag.has(3));
  check('本轮各段由后往前', turnAssistantIndexes(segs).join(',') === '3,1', turnAssistantIndexes(segs).join(','));
  check('轮起点 = 轮边界的下一行(轮内通知不算边界)', turnStartIndex(segs, 3) === 1, String(turnStartIndex(segs, 3)));
}
{
  const segs = [user, a1, retryRow, a2];
  check('重试拆段的前一段仍是中间片段(既有行为不回退)', fragmentIndexes(segs).has(1));
}
{
  const segs = [user, a1, laterUser, a2];
  check('跨轮不误判(两轮各只有一段,都是收尾段)', fragmentIndexes(segs).size === 0, [...fragmentIndexes(segs)].join(','));
  check('跨轮时本轮各段只看当前这一轮', turnAssistantIndexes(segs).join(',') === '3', turnAssistantIndexes(segs).join(','));
}
{
  // 轮内通知之后又来了用户消息:上一轮的两段都在新轮之前,只有最后一段是收尾段
  const segs = [user, a1, inlineNotice, a2, laterUser, { role: 'assistant' }];
  const frag = fragmentIndexes(segs);
  check('上一轮:中间段静默、收尾段仍是收尾段', frag.has(1) && !frag.has(3), [...frag].join(','));
  check('新轮的段不受上一轮影响', !frag.has(5));
}
{
  // 轮首通知开启的新轮:通知两边的 assistant 分属两轮,各自都是收尾段
  const segs = [user, a1, turnHeadNotice, a2];
  check('轮首通知两边的段分属两轮,各自都是收尾段', fragmentIndexes(segs).size === 0, [...fragmentIndexes(segs)].join(','));
}

console.log('\n[三] 回合过程折叠行:一轮只挂一处,重试行属于过程内容');
{
  // 截图场景:一轮被两次重试拆成三段,每段都带着同一个 turnElapsedMs
  const toolSeg = { kind: 'tools', tools: [{ tool: 'read_local_file', ok: true }] };
  const textSeg = (t) => ({ kind: 'text', text: t });
  const row = (segments) => ({ role: 'assistant', segments, turnElapsedMs: 941_000, turnEndReason: 'completed' });
  const rows = [
    user,
    row([textSeg('停 True 是因为直接 kill'), toolSeg]),
    { ...retryRow, retry: { ...retryRow.retry, retry: 1 } },
    row([textSeg('3 个变体都在跑'), toolSeg]),
    { ...retryRow, retry: { ...retryRow.retry, retry: 2 } },
    row([textSeg('恢复时塞的是原始 dict'), toolSeg])
  ];
  const plan = planTurnFold(rows);
  check('折叠行只挂在轮首那一段(宿主)', plan[1].owner === 1 && plan[1].foldable && plan[1].hasProcess, JSON.stringify(plan[1]));
  check('同轮后面的段共用同一个宿主(不再各出一句「已完成」)',
    plan[3].owner === 1 && plan[5].owner === 1, `${plan[3].owner},${plan[5].owner}`);
  check('同轮各段按整轮来判可折叠', plan[3].foldable && plan[5].foldable);
  check('重试提示行是过程内容(折叠时收起)', plan[2].hideWhenFolded && plan[4].hideWhenFolded);
  check('正文/工具段本身不整行收起(正文始终可见)', !plan[1].hideWhenFolded && !plan[3].hideWhenFolded);
  check('用户消息行不参与(owner 为 -1)', plan[0].owner === -1 && !plan[0].hideWhenFolded);
}
{
  // 还在跑的一轮:不折(要能看着它干活),重试行也不收起
  const rows = [
    user,
    { role: 'assistant', segments: [{ kind: 'tools', tools: [{ tool: 'x' }] }], streaming: true },
    retryRow,
    { role: 'assistant', segments: [{ kind: 'text', text: '继续' }], streaming: true }
  ];
  const plan = planTurnFold(rows);
  check('轮内还有段在流式 → 整轮不折', !plan[1].foldable && !plan[3].foldable);
  check('不折时重试提示行照常显示', !plan[2].hideWhenFolded);
}
{
  // 纯文本回复(没有工具/思考):没有可折的过程,也就没有折叠行,重试行不能凭空消失
  const rows = [user, { role: 'assistant', segments: [{ kind: 'text', text: '直接给结论' }] }, retryRow];
  const plan = planTurnFold(rows);
  check('没有过程内容 → 不折', !plan[1].foldable && plan[1].owner === 1 && !plan[1].hasProcess, JSON.stringify(plan[1]));
  check('不折时重试提示行保留', !plan[2].hideWhenFolded);
}
{
  // 跨轮:每轮各自的宿主与开关
  const rows = [
    user,
    { role: 'assistant', segments: [{ kind: 'tools', tools: [{ tool: 'x' }] }] },
    retryRow,
    laterUser,
    { role: 'assistant', segments: [{ kind: 'tools', tools: [{ tool: 'y' }] }] },
    retryRow
  ];
  const plan = planTurnFold(rows);
  check('第一轮的宿主是第一条 assistant', plan[1].owner === 1 && plan[2].owner === 1);
  check('新一轮的宿主是新一轮的第一条 assistant', plan[4].owner === 4 && plan[4].foldable && plan[5].hideWhenFolded);
  check('两轮互不影响', plan[1].owner !== plan[4].owner);
}
{
  // 非重试的 notice 行(⚠ 中断原因等)不是过程内容:折叠不该把它藏起来
  const rows = [
    user,
    { role: 'assistant', segments: [{ kind: 'tools', tools: [{ tool: 'x' }] }] },
    { role: 'notice', content: '⚠ 已中断' }
  ];
  const plan = planTurnFold(rows);
  check('普通提示行不被跳过', plan[2].owner === 1 && !plan[2].hideWhenFolded);
}

console.log('\n[四] 历史投影:文件变更只挂收尾段,且按整轮汇总');
// 从 ChatPanel.tsx 里抽真实的历史投影函数(与 retry-history-position.test.js 同一手法)
const source = readFileSync(new URL('../web/src/components/ChatPanel/ChatPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ChatPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['appendSeg', 'appendText', 'appendReasoning', 'appendTools', 'collectFileChanges', 'turnsToMessages', 'FILE_CHANGE_KINDS', 'LOCAL_FILE_TOOLS']);
const selected = ast.statements.filter((s) => (
  ts.isFunctionDeclaration(s) && names.has(s.name?.text)
) || (ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => names.has(d.name.getText(ast)))));
assert.equal(selected.length, names.size, '历史投影依赖应完整提取');
const js = ts.transpileModule(selected.map((s) => s.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const project = vm.runInNewContext(`${js}\nturnsToMessages`, {
  isRealUserRow, fragmentIndexes, startsNewTurn, mergeAttachments, mergeDeliverables
});

// 一段「assistant 发起文件工具调用 + 工具结果带 diff meta」的 turn(投影会把改动聚合成卡片数据)
const fileTurn = (id, path, addLines) => [
  { role: 'assistant', content: '', tool_calls: [{ id, function: { name: 'edit_local_file', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: id, tool_name: 'edit_local_file', content: 'ok', ok: true, ms: 5, meta: { card: 'diff', path, kind: 'edit', addLines, delLines: 1 } }
];
const pathsOf = (row) => (row.filesChanged || []).map((f) => f.path).sort().join(',');

{
  // 截图场景:轮内通知把这一轮拆成两段
  const rows = project([
    user,
    ...fileTurn('c1', 'server/agent/plan-mode.ts', 3),
    { role: 'assistant', content: '找到根因:`narrate` 标志在 `changed()` 之前被清掉了。修正。' },
    ...fileTurn('c2', 'server/agent/agent.ts', 5),
    inlineNotice,
    ...fileTurn('c3', 'test/goal-plan.test.js', 2),
    { role: 'assistant', content: '子代理的回执确认了服务端逐字正确。' }
  ]);
  check('投影出两段 assistant(轮内通知另起一段)', rows.filter((r) => r.role === 'assistant').length === 2,
    rows.map((r) => r.role).join('|'));
  check('中间段**没有**文件变更卡(它不该长出收尾产物)', rows[1].filesChanged === undefined,
    JSON.stringify(rows[1].filesChanged));
  check('收尾段带文件变更卡', (rows[3].filesChanged || []).length === 3, pathsOf(rows[3]));
  check('整轮口径:通知行之前的改动也计入收尾段的卡',
    pathsOf(rows[3]) === 'server/agent/agent.ts,server/agent/plan-mode.ts,test/goal-plan.test.js', pathsOf(rows[3]));
}

{
  // 轮首通知(非 inline)开启的是**新一轮**:两轮各自统计自己的改动
  const rows = project([
    user,
    ...fileTurn('c1', 'server/agent/plan-mode.ts', 3),
    { role: 'assistant', content: '第一轮收工' },
    turnHeadNotice,
    ...fileTurn('c2', 'server/agent/agent.ts', 5),
    { role: 'assistant', content: '第二轮收工' }
  ]);
  check('轮首通知两边的段分属两轮', rows.filter((r) => r.role === 'assistant').length === 2);
  check('上一轮的段仍带自己的卡(不是中间片段)', pathsOf(rows[1]) === 'server/agent/plan-mode.ts', pathsOf(rows[1]));
  check('新一轮的段只统计本轮改动', pathsOf(rows[3]) === 'server/agent/agent.ts', pathsOf(rows[3]));
}

{
  // 重试拆段:回归保护(改动前就是"只挂收尾段",这里保证没有被新判定改坏)
  const rows = project([
    user,
    ...fileTurn('r1', 'a.ts', 1),
    { role: 'assistant', content: '半成品' },
    { role: 'notice', retry: { retry: 1, retryGroup: 'g', state: 'started', error: 'x', maxRetries: 10, delayMs: 0 } },
    { role: 'assistant', content: '恢复后' },
    ...fileTurn('r2', 'b.ts', 2)
  ]);
  const assistants = rows.map((r, i) => (r.role === 'assistant' ? i : -1)).filter((i) => i >= 0);
  check('重试拆出两段(既有形态不变)', assistants.length === 2, assistants.join(','));
  check('重试前的半成品段没有收尾产物', rows[assistants[0]].filesChanged === undefined);
  check('重试后的收尾段汇总整轮改动', pathsOf(rows[assistants[1]]) === 'a.ts,b.ts', pathsOf(rows[assistants[1]]));
}

console.log(`\n${fail === 0 ? '✓' : '✗'} 收尾段判定与投影:${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
