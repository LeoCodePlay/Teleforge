// 「回到本轮对话发起前」把会话截断成空之后,它必须仍留在任务列表里(用户上报的现场)。
//
// 复现:一个只有一条消息的任务对话 → 点回退 → 聊天记录变空、内容回到输入框 →
// 切到别的会话时,这条会话从任务列表里**消失了**(连列表行都没了),再也点不回去继续发。
// 根因:前端任务列表按 msgCount>0 过滤"空会话",而回退把唯一的用户消息删掉后 msgCount 归零,
// 会话被当成"新建的空会话"隐藏 —— 可它的内容其实还在(输入框草稿按会话 id 存着)。
//
// 区分"从未发过消息的空会话"(该隐藏)与"被回退/删除清空的会话"(该保留)的依据是
// 服务端持久化的 lastUserAt:回退只减少 msgCount,不会把它清回 0。本测试同时校验:
//   1) 可见性规则本身(web/src/utils/sessionVisibility.ts,SessionPanel 用的就是它);
//   2) 服务端现场:真跑一轮再回退,msgCount 归零而 lastUserAt 仍在,规则据此判为可见;
//   3) 对照片:从未发过消息的空会话仍然不占列表位(别把原有的空会话过滤改坏)。
// 运行:node test/session-visibility.test.js
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-session-visible-'));

const { Agent } = await import('../server/agent/agent.ts');
const sessions = await import('../server/store/session-store.ts');
const { showsInTaskList } = await import('../web/src/utils/sessionVisibility.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

// 假文本模型:一轮立刻收尾,测试不需要真实 provider
const fakeLlm = {
  isMock: false, model: 'fake', contextWindow: 0, maxTokens: 100, apiKey: 'k', baseUrl: 'http://x',
  async chat() { return { content: '好的', toolCalls: [] }; }
};
const agent = new Agent({ emit: () => {} });
agent.llm = fakeLlm;
agent.llmConfigured = true;

// ---- 1. 可见性规则本身 ----
console.log('\n[可见性规则]');
check('从未发过消息的空会话不占任务列表位',
  showsInTaskList({ id: 's_a', msgCount: 0 }, { activeId: 's_other' }) === false);
check('有对话内容的会话可见',
  showsInTaskList({ id: 's_a', msgCount: 2 }, { activeId: 's_other' }) === true);
check('被回退/删除清空的会话仍然可见',
  showsInTaskList({ id: 's_a', msgCount: 0, lastUserAt: Date.now() }, { activeId: 's_other' }) === true);
check('旧数据缺 msgCount 但有 lastUserAt → 可见',
  showsInTaskList({ id: 's_a', lastUserAt: 1 }, { activeId: 's_other' }) === true);
check('当前激活的空会话永远可见(否则切进去就找不到自己)',
  showsInTaskList({ id: 's_a', msgCount: 0 }, { activeId: 's_a' }) === true);
check('后台运行中的空会话可见(要能点进去看进度)',
  showsInTaskList({ id: 's_a', msgCount: 0 }, { activeId: 's_other', busyIds: ['s_a'] }) === true);

// ---- 2. 服务端现场:唯一一条消息被回退后,会话必须留在列表里 ----
console.log('\n[只有一个任务对话:回退后会话仍在任务列表]');
const target = agent.createSession('只有一个任务');       // 用户建的任务会话
await agent.run('第一条也是唯一一条消息');                 // 唯一一轮对话(真落盘)
const other = agent.createSession('另一个会话');            // 稍后"切过去"的那个会话
await agent.run('另一个会话的消息');

const rowOf = (id) => sessions.list().find((s) => s.id === id);
const before = rowOf(target.id);
check('回退前:会话有内容、可见', (before.msgCount ?? 0) > 0 && showsInTaskList(before, { activeId: other.id }) === true);

// 用户在界面上点的是那条用户消息上的「回到本轮对话发起前」(服务端按 ordinal 权威定位)——
// 回退作用于**当前活跃会话**,所以先切回目标会话(等价于用户点开这条任务时看到的画面)
agent.switchSession(target.id);
agent.rewindToBefore(-1, { ordinal: 0, text: '第一条也是唯一一条消息' });
const after = rowOf(target.id);
check('回退后:消息面已清空(msgCount 归零)', (after.msgCount ?? 0) === 0, JSON.stringify(after));
check('回退后:事件日志里确实没有用户消息了',
  !sessions.loadEvents(target.id).some((e) => e.type === 'user/message' && e.data?.source === 'user'));
check('回退后:lastUserAt 保留(会话"曾经有过对话"的标记)', (after.lastUserAt ?? 0) > 0, JSON.stringify(after));
check('回退后:切到别的会话时,它仍在任务列表里', showsInTaskList(after, { activeId: other.id }) === true);

// ---- 3. 对照片:真正的空会话不受影响 ----
console.log('\n[对照片:空会话仍被过滤]');
const empty = sessions.create('自动补位的空会话', 'local', {});
const emptyRow = rowOf(empty.id);
check('从未发过消息的会话:msgCount 与 lastUserAt 都是 0',
  (emptyRow.msgCount ?? 0) === 0 && (emptyRow.lastUserAt ?? 0) === 0, JSON.stringify(emptyRow));
check('它不占任务列表位(非激活时被过滤)', showsInTaskList(emptyRow, { activeId: other.id }) === false);

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
