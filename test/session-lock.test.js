// 工作区锁定规则的前后端一致性回归测试(用户上报的现场):
//   本地工作区会话开始对话后,输入框下方的「本地工作区」chip 必须锁定(置灰+锁图标),
//   与服务端 assertLocalWorkspaceChangeable 的裁决完全一致;远程会话的本地工作区是辅助,不锁。
// 历史 bug:前端按「会话自己有没有 localWorkspace」判断,导致正常的本地会话(localWorkspace 非空)
// 反被判成"未锁定"(chip 可点、点开还能选),而服务端会拒绝 —— 用户看到"工作区没被锁"。
// 运行:node test/session-lock.test.js
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-lock-'));
const { Agent } = await import('../server/agent/agent.ts');
const sessions = await import('../server/store/session-store.ts');
const { NO_WORKSPACE } = await import('../server/config.ts');
const { localWorkspaceLocked, remoteWorkspaceLocked, usesRemoteWorkspace } = await import('../web/src/utils/sessionLock.ts');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const agent = new Agent({ emit: () => {} });

// 服务端裁决 → 布尔(抛错 = 已锁定,拒绝修改)
const serverRemoteLocked = (id) => { try { agent.assertRemoteWorkspaceChangeable(id); return false; } catch { return true; } };
const serverLocalLocked = (id) => { try { agent.assertLocalWorkspaceChangeable(id); return false; } catch { return true; } };

const startedEvents = () => [{ seq: 0, time: Date.now(), type: 'user/message', data: { source: 'user', content: '你好' } }];
const mk = (title, opts, started) => {
  const s = sessions.create(title, opts.connKey ?? 'local', {
    workspace: opts.workspace ?? null, localWorkspace: opts.localWorkspace ?? null
  });
  if (started) sessions.saveEvents(s.id, startedEvents());
  return s;
};

console.log('\n[本地工作区锁定 —— 前端 chip 必须与服务端裁决一致]');
const cases = [
  { name: '本地会话(选了本地工作区)+ 已开始对话', s: mk('本地锁', { localWorkspace: 'C:/wsA' }, true), started: true },
  { name: '本地会话 + 未开始对话', s: mk('本地未开始', { localWorkspace: 'C:/wsA' }, false), started: false },
  { name: '「不使用远程工作区(整台服务器)」+ 已开始对话', s: mk('整台服务器', { workspace: NO_WORKSPACE, localWorkspace: 'C:/wsA' }, true), started: true },
  { name: '「不使用本地工作区(整台电脑)」+ 已开始对话', s: mk('整台电脑', { localWorkspace: NO_WORKSPACE }, true), started: true },
  { name: '远程会话(绑定具体远程目录)+ 已开始对话(本地是辅助,不锁)', s: mk('远程', { connKey: 'user@a.com:22', workspace: '/srv/a' }, true), started: true },
  { name: '远程会话 + 未开始对话', s: mk('远程未开始', { connKey: 'user@a.com:22', workspace: '/srv/a' }, false), started: false }
];
for (const c of cases) {
  const fe = localWorkspaceLocked(c.s, c.started);
  const be = serverLocalLocked(c.s.id);
  check(`${c.name}:前端=${fe} 服务端=${be}`, fe === be, JSON.stringify({ fe, be, meta: c.s }));
  const feR = remoteWorkspaceLocked(c.s, c.started);
  const beR = serverRemoteLocked(c.s.id);
  check(`${c.name}:远程 chip 锁定同口径(前端=${feR} 服务端=${beR})`, feR === beR, JSON.stringify({ feR, beR }));
}

console.log('\n[已开始对话的本地会话必须锁上(用户上报的那条)]');
{
  const s = mk('工作区A的任务', { localWorkspace: 'C:/wsA' }, true);
  check('本地工作区会话开始对话后 → 本地 chip 锁定', localWorkspaceLocked(s, true) === true);
  check('服务端同样拒绝改它的本地工作区', serverLocalLocked(s.id) === true);
}
{
  const s = mk('整台服务器干活', { workspace: NO_WORKSPACE, localWorkspace: 'C:/wsA' }, true);
  check('「整台服务器」会话(归本地分组)开始对话后 → 本地 chip 锁定', localWorkspaceLocked(s, true) === true);
}

console.log('\n[草稿 / 未开始对话不锁]');
check('草稿态(还没有会话对象)两侧都不锁',
  !localWorkspaceLocked(undefined, false) && !remoteWorkspaceLocked(undefined, false));
check('新会话草稿(没有 meta)不锁', localWorkspaceLocked(undefined, true) === false);

console.log('\n[占用具体远程目录的判定(与服务端 usesRemoteWorkspace 同口径)]');
check('workspace = null → 不是远程会话', usesRemoteWorkspace({ workspace: null }) === false);
check('workspace = NO_WORKSPACE(整台服务器)→ 不是远程会话', usesRemoteWorkspace({ workspace: NO_WORKSPACE }) === false);
check('workspace = 具体目录 → 是远程会话', usesRemoteWorkspace({ workspace: '/srv/a' }) === true);

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
