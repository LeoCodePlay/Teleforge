// 重试提示行落点单测(前端纯函数 applyRetryNotice):
// 用户诉求 —— 重试行要落在**失败发生的那一刻**,不要一直贴在整轮回复的最下面;
// 且同一轮里重复的重试(同一原因 / 每个 step 都先撞到无余额的 Key)只显示一行。
//
// 规则:
//   - 本轮首次重试:当前流式气泡在失败点收尾 → 重试行 → 新的流式气泡(后续增量落在下面);
//   - 同一轮重复重试:原地更新计数/原因,不拆气泡、不新增行;
//   - 新一轮(user 消息之后)才另起一行;
//   - 本轮已收尾(turnClosed)的陈旧重试事件只追加一行,不拆历史气泡。
import { applyRetryNotice, tailAssistantIndex } from '../web/src/utils/compactionOrder.ts';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const shape = (msgs) => msgs.map((m) => (m.retry ? `retry(${m.retry.retry})` : m.role === 'assistant' ? `asst${m.streaming ? '*' : ''}` : m.role)).join(' | ');
const retryInput = (retry = 1, error = '网络错误') => ({ retry, maxRetries: 10, delayMs: 2000, error });

console.log('== 重试提示行落点 ==');

// 1) 首次重试:在失败点拆开回复,重试行夹在前后内容之间
{
  const msgs = [
    { role: 'user', content: '问' },
    { role: 'assistant', streaming: true, segments: [{ kind: 'text', text: '前半段' }] }
  ];
  const out = applyRetryNotice(msgs, retryInput(), { turnClosed: false, forkFaceIdx: 7 });
  check('结构=用户 | 收尾气泡 | 重试行 | 新流式气泡', shape(out) === 'user | asst | retry(1) | asst*', shape(out));
  check('旧气泡保留已产出的内容', out[1].segments && out[1].segments[0].text === '前半段');
  check('旧气泡在失败点收尾(不再流式)', out[1].streaming === false);
  check('重试行落在失败点(旧气泡之后、新气泡之前)', out[2].role === 'notice' && !!out[2].retry && out[2].retry.state === 'scheduled');
  check('新气泡可继续流式落点', out[3].role === 'assistant' && out[3].streaming === true && tailAssistantIndex(out) === 3);
  check('新气泡分支点=重试行下标', out[3].forkTail === 7);
  check('不修改传入数组', msgs.length === 2);
}

// 2) 同一轮重复重试(同一原因):原地更新,只占一行,不重复拆气泡
{
  let msgs = [
    { role: 'user', content: '问' },
    { role: 'assistant', streaming: true, segments: [{ kind: 'text', text: '已输出的内容' }] }
  ];
  msgs = applyRetryNotice(msgs, retryInput(1, 'API Key 余额不足,已切换到第 2/4 个可用 Key'), { turnClosed: false, forkFaceIdx: 1 });
  msgs = applyRetryNotice(msgs, retryInput(1, 'API Key 余额不足,已切换到第 2/4 个可用 Key'), { turnClosed: false, forkFaceIdx: 2 });
  msgs = applyRetryNotice(msgs, retryInput(2, 'API Key 余额不足,已切换到第 2/4 个可用 Key'), { turnClosed: false, forkFaceIdx: 3 });
  const rows = msgs.filter((m) => m.retry);
  check('重复重试仍然只有一行', rows.length === 1, shape(msgs));
  check('计数更新为最新(1→2)', rows[0].retry.retry === 2);
  check('结构没被重复拆开', shape(msgs) === 'user | asst | retry(2) | asst*', shape(msgs));
  check('本轮仍有流式气泡(倒计时等待不等于收尾)', tailAssistantIndex(msgs) === 3);
}

// 3) 新一轮(user 之后)才另起一行
{
  let msgs = [
    { role: 'user', content: '第一轮' },
    { role: 'assistant', streaming: true, segments: [] }
  ];
  msgs = applyRetryNotice(msgs, retryInput(), { turnClosed: false, forkFaceIdx: 1 });
  msgs.push({ role: 'user', content: '第二轮' });
  msgs.push({ role: 'assistant', streaming: true, segments: [] });
  msgs = applyRetryNotice(msgs, retryInput(), { turnClosed: false, forkFaceIdx: 4 });
  check('两轮各占一行(不跨轮合并)', msgs.filter((m) => m.retry).length === 2, shape(msgs));
}

// 4) 本轮已收尾的陈旧重试事件:只追加一行记录,不拆历史气泡
{
  const msgs = [
    { role: 'user', content: '问' },
    { role: 'assistant', streaming: false, segments: [{ kind: 'text', text: '答' }] }
  ];
  const out = applyRetryNotice(msgs, retryInput(), { turnClosed: true, forkFaceIdx: 9 });
  check('已收尾:不新起流式气泡', out.every((m) => !(m.role === 'assistant' && m.streaming)), shape(out));
  check('已收尾:只多出一行重试记录', out.length === 3 && out[2].role === 'notice' && !!out[2].retry, shape(out));
}

// 5) 本轮还没有气泡(极端时序):提示行在前,内容流进后面的新气泡
{
  const out = applyRetryNotice([{ role: 'user', content: '问' }], retryInput(), { turnClosed: false, forkFaceIdx: 0 });
  check('无气泡:重试行排在新流式气泡之前', shape(out) === 'user | retry(1) | asst*', shape(out));
}

// 6) discard 半成品回滚标记随行下发(供详情披露)
{
  const out = applyRetryNotice([{ role: 'assistant', streaming: true, segments: [] }], { ...retryInput(), discard: true }, { turnClosed: false, forkFaceIdx: 1 });
  const row = out.find((m) => m.retry);
  check('discard 标记保留', row.retry.discard === true);
}

// 7) 刚开场就失败(本轮还没有任何内容):不留空气泡,重试行直接占位(与历史投影一致)
{
  const out = applyRetryNotice([{ role: 'user', content: '问' }, { role: 'assistant', streaming: true, segments: [] }], retryInput(), { turnClosed: false, forkFaceIdx: 1 });
  check('开场失败:没有空白气泡', shape(out) === 'user | retry(1) | asst*', shape(out));
  check('开场失败:唯一 assistant 是新的流式气泡', out.filter((m) => m.role === 'assistant').length === 1 && out[2].streaming === true, shape(out));
}

// 8) 压缩标记行 / 命令卡的 role 同样是 'user',但它们不是新一轮:
//    夹在重试行后面的压缩行不能把「同轮已有重试行」挡掉,否则长会话里每次重试都会新增一行,
//    一路堆在对话末尾(用户报的「重试消息一直都有、一直显示在最下面」就是这条路径)。
{
  let msgs = [
    { role: 'user', content: '问' },
    { role: 'assistant', streaming: true, segments: [{ kind: 'text', text: '前半段' }] }
  ];
  msgs = applyRetryNotice(msgs, retryInput(1, 'API Key 余额不足,已切换到第 2/3 个可用 Key'), { turnClosed: false, forkFaceIdx: 1 });
  // 自动压缩标记行插在重试行之后(role 也是 'user')
  msgs.splice(msgs.length - 1, 0, { role: 'user', content: '', compaction: { dropCount: 12, manual: false } });
  msgs = applyRetryNotice(msgs, retryInput(2, 'API Key 余额不足,已切换到第 2/3 个可用 Key'), { turnClosed: false, forkFaceIdx: 2 });
  check('压缩标记行不阻断同轮合并:仍然只有一行', msgs.filter((m) => m.retry).length === 1, shape(msgs));
  check('计数原地更新为 2', msgs.filter((m) => m.retry)[0].retry.retry === 2, shape(msgs));

  // 斜杠命令卡(role 同样是 'user')同理
  let msgs2 = [
    { role: 'user', content: '问' },
    { role: 'assistant', streaming: true, segments: [{ kind: 'text', text: '内容' }] }
  ];
  msgs2 = applyRetryNotice(msgs2, retryInput(1), { turnClosed: false, forkFaceIdx: 1 });
  msgs2.splice(msgs2.length - 1, 0, { role: 'user', content: '', command: { name: '/compact', state: 'ok' } });
  msgs2 = applyRetryNotice(msgs2, retryInput(2), { turnClosed: false, forkFaceIdx: 2 });
  check('命令卡不阻断同轮合并:仍然只有一行', msgs2.filter((m) => m.retry).length === 1, shape(msgs2));

  // 真正的用户消息仍然要另起一行(不能被改坏)
  let msgs3 = [{ role: 'user', content: '第一轮' }, { role: 'assistant', streaming: true, segments: [] }];
  msgs3 = applyRetryNotice(msgs3, retryInput(1), { turnClosed: false, forkFaceIdx: 1 });
  msgs3.push({ role: 'user', content: '第二轮' }, { role: 'assistant', streaming: true, segments: [] });
  msgs3 = applyRetryNotice(msgs3, retryInput(1), { turnClosed: false, forkFaceIdx: 4 });
  check('真正的用户消息仍然另起一行', msgs3.filter((m) => m.retry).length === 2, shape(msgs3));
}

// 9) 换 Key(kind='switch'):立即重发、没有等待 —— 落点数据要能把这件事传给渲染层
{
  const out = applyRetryNotice(
    [{ role: 'user', content: '问' }, { role: 'assistant', streaming: true, segments: [] }],
    { ...retryInput(1, 'API Key 余额不足,已切换到第 2/3 个可用 Key'), delayMs: 0, kind: 'switch' },
    { turnClosed: false, forkFaceIdx: 1 }
  );
  const row = out.find((m) => m.retry);
  check('kind=switch 透传到重试行', row?.retry?.kind === 'switch', JSON.stringify(row?.retry));
  check('换 Key 的 delayMs 保持 0(不伪造等待)', row?.retry?.delayMs === 0, String(row?.retry?.delayMs));
}

console.log(`\n${fail === 0 ? '✓' : '✗'} 重试提示行落点:${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
