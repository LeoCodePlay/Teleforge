// 技能目录门控修复:未连 SSH、未选远程工作区时,内置+本机技能仍可发现与加载
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-sk-'));
// 在 import 前用本机技能根目录指向临时目录(避免污染真实 ~/.agents/skills)
process.env.LOCAL_USER_SKILLS = mkdtempSync(path.join(tmpdir(), 'sshai-lu-'));
writeFileSync(path.join(process.env.LOCAL_USER_SKILLS, 'my-local-skill.md'), '---\nname: my-local-skill\ndescription: 测试本地技能\n---\n\n# 正文\n这是本地技能指令。\n');
const { refreshSkillsCatalog, getSkillsCatalog } = await import('../server/agent/tools.js');
const { sshManager: ssh } = await import('../server/ssh-manager.js');
const { localFs } = await import('../server/local-fs.js');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

// 关键:无 SSH、无远程工作区
ssh.status = 'disconnected';
ssh.workspace = null;
ssh.home = null;
localFs.workspace = null;

const catalog = await refreshSkillsCatalog();
check('无 SSH 时目录含内置技能', catalog.some((s) => s.source === 'builtin'), '');
check('无 SSH 时目录含本机用户技能', catalog.some((s) => s.name === 'my-local-skill'), JSON.stringify(catalog.map((s) => s.name)));
const got = getSkillsCatalog();
check('getSkillsCatalog 无工作区不再返回空', got.length > 0, `len=${got.length}`);
check('getSkillsCatalog 含本机技能', got.some((s) => s.name === 'my-local-skill'));

// 加载正文(无 SSH)
const { loadSkillContent } = await import('../server/agent/tools.js');
const loaded = await loadSkillContent('my-local-skill');
check('无 SSH 时 loadSkillContent 加载本机技能正文', loaded && loaded.content.includes('这是本地技能指令'), JSON.stringify(loaded));

// local-workspace 来源:设置本地工作区并在其中写同名技能,验证被扫描且优先级高于 local-user
localFs.workspace = mkdtempSync(path.join(tmpdir(), 'sshai-lws-'));
mkdirSync(path.join(localFs.workspace, '.agents', 'skills'), { recursive: true });
writeFileSync(path.join(localFs.workspace, '.agents', 'skills', 'my-local-skill.md'), '---\nname: my-local-skill\ndescription: 本地工作区技能\n---\n\n# 正文\n工作区级指令。\n');
const catalog2 = await refreshSkillsCatalog();
const wsSkill = catalog2.find((s) => s.name === 'my-local-skill');
check('local-workspace 来源被扫描且优先级覆盖 local-user', wsSkill && wsSkill.source === 'local-workspace', JSON.stringify(wsSkill));
console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
