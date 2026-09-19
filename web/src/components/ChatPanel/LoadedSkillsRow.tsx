// 「已加载技能」行:用户用 `/技能名` 手动调用技能时的可见反馈。
// 服务端把技能正文整篇注入本轮用户消息(前端拿不到全文,只有 600 字预览),所以这行
// 声明"哪些技能已经进入上下文",展开体给正文预览;模型主动调用 skill 工具的路径由
// SkillRow 的工具卡片承担 —— 两条路径都要看得见,否则用户无法判断技能到底进没进。
// 视觉与 SkillRow 一致(前导技能图标 + 标题 + 2x2 分隔点 + 摘要 + 展开卡)。

import React from 'react';
import type { LoadedSkill } from '../../types';
import { ToolRow } from '../ToolRow/ToolRow';
import { IconSkillOutline16 } from '../icons/icons';
import './LoadedSkillsRow.scss';

export function LoadedSkillsRow({ skills }: { skills: LoadedSkill[] }) {
  const items = (skills || []).filter((s) => s && s.name);
  if (items.length === 0) return null;
  const card = (
    <div className="loaded-skills-card">
      {items.map((s) => (
        <div className="loaded-skills-item" key={s.name}>
          <div className="loaded-skills-head">
            <span className="loaded-skills-name">{s.name}</span>
            {!!s.description && <span className="loaded-skills-desc">{s.description}</span>}
          </div>
          {!!s.preview && (
            <>
              <pre className="loaded-skills-body">{s.preview}</pre>
              <div className="loaded-skills-note">正文预览(前 600 字;完整正文已随本轮消息注入模型)</div>
            </>
          )}
        </div>
      ))}
    </div>
  );
  return (
    <div className="loaded-skills">
      <ToolRow
        variant="others"
        toolName="skill"
        icon={<IconSkillOutline16 size={14} />}
        title="已加载技能"
        summary={items.map((s) => s.name).join('、')}
        body={null}
        output={null}
        state="ok"
        card={card}
      />
    </div>
  );
}
