// 技能管理消息:skills_list / skill_get / skill_save / skill_delete / skill_copy_builtin
import { refreshSkillsCatalog, getSkillFull, saveSkill, deleteSkill, copyBuiltinToRemote } from '../agent/tools.js';

export function registerSkills(rpc) {
  rpc.register('skills_list', async (msg, { reply }) => {
    // 原 ws.js skills_list case(257-262)逐字复制
    // 管理界面打开/刷新时强制重扫目录,保证看到最新文件状态;未连接时仅返回内置+本机技能
    const skills = await refreshSkillsCatalog();
    reply({ type: 'skills', skills });
  });

  rpc.register('skill_get', async (msg, { reply }) => {
    // 原 ws.js skill_get case(263-268)逐字复制
    const skill = await getSkillFull(msg.name);
    if (!skill) throw new Error(`技能不存在: ${msg.name}`);
    reply({ type: 'skill', ...skill });
  });

  rpc.register('skill_save', async (msg, { reply }) => {
    // 原 ws.js skill_save case(269-274)逐字复制
    // 本机目标(local-project/local-user)无需 SSH;远程目标内部会校验连接
    const r = await saveSkill(msg);
    reply({ type: 'ok', file: r.file, skills: r.skills });
  });

  rpc.register('skill_delete', async (msg, { reply }) => {
    // 原 ws.js skill_delete case(275-279)逐字复制
    const skills = await deleteSkill(msg.name);
    reply({ type: 'ok', skills });
  });

  rpc.register('skill_copy_builtin', async (msg, { reply }) => {
    // 原 ws.js skill_copy_builtin case(280-285)逐字复制
    // 把内置技能(随工具分发的本地技能库)复制到本机或远程项目级/用户级
    const r = await copyBuiltinToRemote({ name: msg.name, file: `builtin://${msg.name}/SKILL.md` }, msg.target);
    reply({ type: 'ok', ...r, skills: await refreshSkillsCatalog() });
  });
}
