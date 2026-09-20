// 生图成图「工作区落盘」路由测试:
//   远程工作区已选 → 远程(SFTP) ;否则本地工作区已选 → 本地;
//   远程处于「不在工作区对话」→ 回落本地;两者都没选 → 只留在会话附件里。
// 远程连接用 Object.defineProperty 在单例上打桩(记录 writeRemoteFile 调用),不打真实网络。
// 需在临时 DATA_DIR 里隔离运行(会写附件)。
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-igws-'));
const { runImageJob } = await import('../server/agent/image-gen.ts');
const { attachmentPath } = await import('../server/store/attachments-store.ts');
const { localFs } = await import('../server/core/local-fs.ts');
const { sshManager } = await import('../server/core/ssh-manager.ts');
const { GENERATED_IMAGES_DIRNAME } = await import('../server/config.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

// 最小合法 1x1 PNG(假上游返回的"成图"字节)
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const fakeLlm = {
  async generateImage() { return [{ buf: PNG_1X1, mime: 'image/png', size: '1024x1024', model: 'fake' }]; }
};

async function main() {
  // ---------- 1) 远程与本地都没选 → 只留在会话附件里 ----------
  localFs.noWorkspace = false;
  localFs.workspace = null;
  let job = await runImageJob({ llm: fakeLlm, prompt: 'p' });
  check('都没选:不写工作区', job.workspaceSaved.length === 0 && !job.workspaceError, JSON.stringify(job.workspaceSaved));
  check('都没选:成图仍落会话附件', job.saved.length === 1 && !!attachmentPath(job.saved[0].id));

  // ---------- 2) 仅本地工作区 → 写本地工作区 generated-images ----------
  const localWs = mkdtempSync(join(tmpdir(), 'sshai-lws-'));
  localFs.workspace = localWs;
  job = await runImageJob({ llm: fakeLlm, prompt: 'p' });
  const localDest = join(localWs, GENERATED_IMAGES_DIRNAME, job.saved[0].name);
  check('本地工作区:路径正确', job.workspaceSaved.length === 1 && job.workspaceSaved[0] === localDest, JSON.stringify(job.workspaceSaved));
  check('本地工作区:文件存在且字节一致', existsSync(localDest) && readFileSync(localDest).equals(PNG_1X1));

  // ---------- 3) 远程工作区已选 → 优先远程(经 SFTP) ----------
  const remoteCalls = [];
  const localWs2 = mkdtempSync(join(tmpdir(), 'sshai-lws2-'));
  localFs.workspace = localWs2;
  Object.defineProperty(sshManager, 'active', {
    configurable: true,
    get: () => ({ writeRemoteFile: async (p, b) => { remoteCalls.push([p, b.length]); return b.length; } })
  });
  Object.defineProperty(sshManager, 'workspace', { configurable: true, get: () => '/home/app' });
  job = await runImageJob({ llm: fakeLlm, prompt: 'p' });
  check('远程已选:优先写远程工作区',
    job.workspaceSaved.length === 1 && job.workspaceSaved[0].startsWith('/home/app/' + GENERATED_IMAGES_DIRNAME + '/'),
    JSON.stringify(job.workspaceSaved));
  check('远程已选:经 SFTP 上传且字节数一致',
    remoteCalls.length === 1 && remoteCalls[0][1] === PNG_1X1.length, JSON.stringify(remoteCalls));
  check('远程已选:本地工作区不再重复写', !existsSync(join(localWs2, GENERATED_IMAGES_DIRNAME)));

  // ---------- 4) 远程「不在服务器工作区」→ 回落本地工作区 ----------
  Object.defineProperty(sshManager, 'workspace', { configurable: true, get: () => null });
  Object.defineProperty(sshManager, 'noWorkspace', { configurable: true, get: () => true });
  remoteCalls.length = 0;
  job = await runImageJob({ llm: fakeLlm, prompt: 'p' });
  check('远程全盘模式:回落本地工作区',
    job.workspaceSaved.length === 1 && job.workspaceSaved[0].startsWith(join(localWs2, GENERATED_IMAGES_DIRNAME)),
    JSON.stringify(job.workspaceSaved));
  check('远程全盘模式:未走 SFTP', remoteCalls.length === 0);

  // ---------- 5) 远程无连接 + 本地也全盘 → 只留会话附件 ----------
  Object.defineProperty(sshManager, 'active', { configurable: true, get: () => null });
  localFs.noWorkspace = true;
  job = await runImageJob({ llm: fakeLlm, prompt: 'p' });
  check('都不可用:只留会话附件', job.workspaceSaved.length === 0, JSON.stringify(job.workspaceSaved));

  console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
