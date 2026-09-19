// 压缩标记行位置单测:标记行按事件日志**原位投影**——压缩发生那一刻它落在当时最后一条
// 消息之后,之后作为普通历史记录固定在那里(刷新/切回会话位置不变,既不飘到保留区之前,
// 也不每次重载都被搬到最底部)。
//
// 规则:
//   - 服务端 projectEvents 原位投影(见 test/compaction-persistence.test.js 的下标同构断言);
//   - 流式落点必须跳过标记行(tailAssistantIndex),否则增量会被静默丢弃;
//   - 「模型可见面」起点由服务端下发的 compaction.retainedFrom 换算成 modelFaceFrom,
//     再由 utils/tokens 的 modelFaceMessages 还原 [摘要标记行, ...保留区及更新消息]。
import { tailAssistantIndex } from '../web/src/utils/compactionOrder.ts';
import { modelFaceMessages } from '../web/src/utils/tokens.ts';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

const user = (content) => ({ role: 'user', content });
const asst = (content, streaming = false) => ({ role: 'assistant', content, streaming });
const marker = (extra = {}) => ({ role: 'user', content: '【上下文已压缩】摘要', compaction: { dropCount: 3, ...extra } });

// ---- 1. tailAssistantIndex:跳过标记行,仍找到本轮 assistant(流式增量落点) ----
{
  // 实时压缩把运行态行插在流式 assistant **之前**(与服务端原位投影一致),
  // 但断线补发等路径仍可能让标记行排到 assistant 之后,这里必须两种都能命中。
  check('标记行排在 assistant 之前:命中流式 assistant', tailAssistantIndex([user('问'), marker(), asst('', true)]) === 2);
  check('标记行排在 assistant 之后仍能找到它', tailAssistantIndex([user('问'), asst('', true), marker()]) === 1);
  check('多条标记行也能跳过', tailAssistantIndex([user('问'), asst('', true), marker(), marker()]) === 1);
  check('末尾不是 assistant 时返回 -1', tailAssistantIndex([user('问'), marker()]) === -1);
  check('空数组返回 -1', tailAssistantIndex([]) === -1);
  check('无标记行:末尾 assistant 正常命中', tailAssistantIndex([user('问'), asst('答')]) === 1);
}

// ---- 2. modelFaceMessages:自动压缩的原位布局 [.. 保留区, 标记行, 回复] ----
// 服务端日志顺序:user(新问题) → compaction/done → assistant(回复)。
// 原位投影后标记行夹在「新问题」与「回复」之间,retainedFrom 指向保留区首条(新问题)。
{
  const rendered = [user('很早的问题'), asst('很早的回答'), user('新问题'), marker({ dropCount: 2, modelFaceFrom: 2 }), asst('新回答')];
  const face = modelFaceMessages(rendered);
  check('原位布局:模型面 = 摘要标记行 + 保留区(新问题/新回答)',
    face.length === 3 && face[0] === rendered[3] && face[1] === rendered[2] && face[2] === rendered[4],
    JSON.stringify(face.map((m) => m.content)));
}

// ---- 3. modelFaceMessages:手动 /compact 的原位布局 [.. 最后一条回复, 标记行] ----
// 手动压缩发生在会话空闲时:标记行追加在日志末尾(当时最后一条消息之后),原位投影即在最末。
{
  const rendered = [user('旧问题'), asst('旧回答'), user('新问题'), asst('新回答'), marker({ dropCount: 2, modelFaceFrom: 2 })];
  const face = modelFaceMessages(rendered);
  check('手动压缩:模型面 = 摘要标记行 + 保留区(新问题/新回答)',
    face.length === 3 && face[0] === rendered[4] && face[1] === rendered[2] && face[2] === rendered[3],
    JSON.stringify(face.map((m) => m.content)));
}

// ---- 4. 多次压缩:只按最后一个标记行切片(更早的标记行不重复进模型面) ----
{
  const m1 = marker({ dropCount: 1, modelFaceFrom: 1 });
  const m2 = marker({ dropCount: 2, manual: true, modelFaceFrom: 3 });
  const rendered = [user('A'), m1, asst('a'), user('B'), m2, asst('b')];
  const face = modelFaceMessages(rendered);
  check('多次压缩:只从最后一个标记行起算,且不重复带入旧标记行',
    face.length === 3 && face[0] === m2 && face[1] === rendered[3] && face[2] === rendered[5],
    JSON.stringify(face.map((m) => m.content)));
}

// ---- 5. 失败行不改变模型面(没压成就不能显示水位变小) ----
{
  const failed = { role: 'user', content: '', compaction: { failed: true, reason: '摘要不可用' } };
  const rendered = [user('问题'), asst('回答'), failed];
  check('只有失败行时模型面 = 全量历史', modelFaceMessages(rendered) === rendered);
  const withBoth = [user('旧'), asst('旧答'), user('新'), marker({ dropCount: 1, modelFaceFrom: 2 }), asst('新答'), failed];
  const face = modelFaceMessages(withBoth);
  check('成功标记行 + 失败行:仍按成功的那个切片', face.length === 3 && face[0] === withBoth[3] && face[1] === withBoth[2]);
}

// ---- 6. 缺 modelFaceFrom 时退回旧口径(不抛错,兼容实时追加的标记行) ----
{
  const noFrom = [user('旧'), asst('旧答'), user('新'), marker(), asst('新答')];
  const face = modelFaceMessages(noFrom);
  check('缺 modelFaceFrom 时退回「从标记行下标起」', face.length === 2 && face[0] === noFrom[3] && face[1] === noFrom[4],
    JSON.stringify(face.map((m) => m.content)));
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
