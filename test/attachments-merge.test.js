// mergeAttachments 单测:同一条回复里多批附件必须累加,不能被后到的覆盖。
// 回归背景:文本模型一次 run 里连续调用三次生成图片工具(各生成一张),服务端为每次调用各落一条
// image/generated、各广播一条 image_done;历史回放把这三条投影成同一气泡内相邻的三条 assistant
// 消息。前端旧实现是 `prev.attachments = t.attachments` / `{ attachments: m.attachments }` 赋值覆盖,
// 只剩最后一批成图可见——用户报的「连续生成了三次,这个会话只显示了一张图片」。
// 另外断线补偿会重放同一批附件(服务端补发),因此累加必须按 id 去重。
import { mergeAttachments } from '../web/src/utils/mergeAttachments.ts';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const att = (id, name = `${id}.png`) => ({ id, name, mime: 'image/png', size: 1024, kind: 'image' });

// ---- 1. 回归:连续三次生图(每批一张)全部保留,顺序与到达顺序一致 ----
{
  const a = [att('a')], b = [att('b')], c = [att('c')];
  const m1 = mergeAttachments(undefined, a);
  const m2 = mergeAttachments(m1, b);
  const m3 = mergeAttachments(m2, c);
  check('三批累加为三张', m3.length === 3, JSON.stringify(m3.map((x) => x.id)));
  check('顺序 = 到达顺序', m3.map((x) => x.id).join(',') === 'a,b,c', m3.map((x) => x.id).join(','));
  check('旧实现会只剩最后一张(此处断言不是只留 c)', m3.map((x) => x.id).join(',') !== 'c');
}

// ---- 2. 单批多张 + 后续批次都要保留 ----
{
  const m = mergeAttachments([att('a'), att('b')], [att('c')]);
  check('一批多张后再追加', m.length === 3 && m[1].id === 'b' && m[2].id === 'c');
}

// ---- 3. 断线补发重放同一批:按 id 去重 ----
{
  const batch = [att('a'), att('b')];
  const m = mergeAttachments(batch, [att('a'), att('b')]);
  check('重放同一批不产生重复图', m.length === 2 && m.map((x) => x.id).join(',') === 'a,b');
  const m2 = mergeAttachments([att('a')], [att('a'), att('c')]);
  check('部分重叠只补新图', m2.map((x) => x.id).join(',') === 'a,c', m2.map((x) => x.id).join(','));
}

// ---- 4. 空值语义:两批都空返回 undefined(调用方据此不写 attachments 字段) ----
{
  check('都为空 → undefined', mergeAttachments(undefined, undefined) === undefined);
  check('都为空数组 → undefined', mergeAttachments([], []) === undefined);
  check('next 为空 → 原样保留已有批', mergeAttachments([att('a')], [])?.map((x) => x.id).join(',') === 'a');
  check('prev 为空 → 直接用新批(同一引用)', mergeAttachments(undefined, [att('a')])?.[0].id === 'a');
}

// ---- 5. 不突变入参 ----
{
  const prev = [att('a')], next = [att('b')];
  const out = mergeAttachments(prev, next);
  check('不改写入参数组', prev.length === 1 && next.length === 1 && out.length === 2);
}

console.log(`\nattachments-merge: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
