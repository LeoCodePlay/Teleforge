// 隔离环境端到端验证:真实数据上模拟"点击第一条 AI 回复的分支"完整链路
// (前端 turnsToMessages 计算 forkTail -> session_fork{at} -> forkSession 截断)
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-e2e-'));
process.env.DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'sessions'), { recursive: true });

// 复制真实会话数据到隔离环境(不碰真实 data/)
const real = JSON.parse(fs.readFileSync(new URL('../data/sessions/s_mtiju3tl9bxm4o.json', import.meta.url), 'utf8'));
fs.writeFileSync(path.join(TMP, 'sessions.json'), JSON.stringify({
  version: 1, active: 's_real', msgCount: 0,
  sessions: [{ id: 's_real', title: '列出3个任务步骤', createdAt: Date.now(), updatedAt: Date.now(), msgCount: 0 }]
}));
fs.writeFileSync(path.join(TMP, 'sessions', 's_real.json'), JSON.stringify(real));

// DATA_DIR 已就绪,动态 import 使其生效
const { Agent } = await import('../server/agent/agent.js');

const agent = new Agent({ emit: () => {} });
const sid = agent.getSessionId();
const turns = agent.getHistory(sid);
console.log(`真实会话 turns 总数: ${turns.length}`);

// === 前端 turnsToMessages 的 forkTail 语义(与 ChatPanel.tsx 一致)===
// 合并连续 assistant/tool turn 为一条回复;每条消息的 forkTail = 其最后一条 turn 的索引
function turnsToMessages(ts) {
  const out = [];
  ts.forEach((t, ti) => {
    if (t.role === 'tool') { const l = out[out.length - 1]; if (l) l.forkTail = ti; return; }
    if (t.role === 'user') { out.push({ role: 'user', forkTail: ti }); return; }
    if (t.role === 'assistant') {
      const prev = out[out.length - 1];
      if (prev && prev.role === 'assistant') prev.forkTail = ti;
      else out.push({ role: 'assistant', forkTail: ti });
    }
  });
  return out;
}
const msgs = turnsToMessages(turns);
const rendered = msgs.map((m, i) => `${i}. ${m.role} forkTail=${m.forkTail}`);
console.log('渲染消息(前6条):');
rendered.slice(0, 6).forEach((r) => console.log('  ' + r));

// 第一条 AI 回复 = 第一条 role=assistant 的渲染消息
const firstAi = msgs.find((m) => m.role === 'assistant');
console.log(`\n第一条 AI 回复的 forkTail = ${firstAi.forkTail}`);
console.log(`该回复之后的渲染消息数(应被截掉): ${msgs.length - msgs.indexOf(firstAi) - 1}`);

// === 模拟点击该回复的分支按钮 ===
const forked = agent.forkSession(firstAi.forkTail);
const newTurns = agent.getHistory(forked.id);
console.log(`\n分支后新会话 turns 总数: ${newTurns.length} (期望 ${firstAi.forkTail + 1})`);
console.log('新会话最后一条 turn:', newTurns[newTurns.length - 1]?.role, String(newTurns[newTurns.length - 1]?.content || '').slice(0, 40));

// 验证:新会话恰好 = 原会话 turns[0..forkTail]
let same = newTurns.length === firstAi.forkTail + 1;
for (let i = 0; same && i < newTurns.length; i++) {
  if (newTurns[i].role !== turns[i].role || String(newTurns[i].content || '') !== String(turns[i].content || '')) same = false;
}
console.log(`\n结果: ${same ? '✓ 分支精确截断到第一条 AI 回复,后续对话全部去掉' : '✗ 截断不正确(BUG)'}`);

// 再验证从尾部整体分支(-1)仍完整
const tailFork = agent.forkSession(-1);
console.log(`尾部分支(-1) turns = ${agent.getHistory(tailFork.id).length} (期望 ${turns.length}): ${agent.getHistory(tailFork.id).length === turns.length ? '✓' : '✗'}`);

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(same ? 0 : 1);
