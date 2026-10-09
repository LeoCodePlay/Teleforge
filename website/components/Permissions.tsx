'use client';

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Reveal } from './Reveal';

type ModeId = 'confirm' | 'auto-edit' | 'plan' | 'full-access';
type Verdict = '自动' | '需批准' | '拒绝';

const MODES: { id: ModeId; name: string; tag: string; desc: string }[] = [
  { id: 'confirm', name: '确认', tag: '默认', desc: '写文件、编辑、删除与执行命令前弹窗请求批准,拒绝后模型会收到结构化错误并调整方案。' },
  { id: 'auto-edit', name: '自动编辑', tag: '', desc: '文件的写入与编辑自动执行,执行命令前仍然需要你点一下。适合边看边改的整理工作。' },
  { id: 'plan', name: '计划模式', tag: '', desc: '只读研究阶段:写与执行类工具直接拒绝,模型只调研并给出计划,由你批准后再执行。' },
  { id: 'full-access', name: '完全访问', tag: '高危', desc: '全部操作自动执行,不再逐项询问;毁灭性命令的拦截守卫仍然生效。' },
];

const OPS = ['读取文件', '写入与编辑', '删除路径', '执行命令'];

const MATRIX: Record<ModeId, Verdict[]> = {
  confirm: ['自动', '需批准', '需批准', '需批准'],
  'auto-edit': ['自动', '自动', '需批准', '需批准'],
  plan: ['自动', '拒绝', '拒绝', '拒绝'],
  'full-access': ['自动', '自动', '自动', '自动'],
};

export function Permissions() {
  const [mode, setMode] = useState<ModeId>('confirm');
  const reduce = useReducedMotion();
  const active = MODES.find((m) => m.id === mode)!;

  return (
    <section className="section perm" id="permission">
      <div className="wrap">
        <Reveal className="sechead">
          <h2 className="h2">
            四档权限,
            <br />
            由你决定 AI 能走多远
          </h2>
          <p className="lede sechead__lede">
            权限档位在对话中随时可切,并且随会话持久化。选中的档位直接决定下面这张表里每一类操作的处理方式。
          </p>
        </Reveal>

        <Reveal className="perm__grid" delay={0.06}>
          <div className="perm__list" role="tablist" aria-label="权限模式">
            {MODES.map((m) => {
              const on = m.id === mode;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  className={`perm__item${on ? ' is-on' : ''}${m.id === 'full-access' ? ' is-danger' : ''}`}
                  onClick={() => setMode(m.id)}
                >
                  {on && (
                    <motion.span
                      layoutId="perm-pill"
                      className="perm__pill"
                      transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 36 }}
                    />
                  )}
                  <span className="perm__name">
                    {m.name}
                    {m.tag && <span className="perm__tag mono">{m.tag}</span>}
                  </span>
                  <span className="perm__desc">{m.desc}</span>
                </button>
              );
            })}
          </div>

          <div className="perm__panel">
            <div className="perm__panel-head">
              <span className="mono">当前档位</span>
              <strong>{active.name}</strong>
            </div>

            <ul className="matrix">
              {OPS.map((op, i) => (
                <li className="matrix__row" key={op}>
                  <span className="matrix__op">{op}</span>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={`${mode}-${op}`}
                      className={`matrix__cell is-${i === 0 ? 'auto' : MATRIX[mode][i] === '自动' ? 'auto' : MATRIX[mode][i] === '拒绝' ? 'deny' : 'ask'}`}
                      initial={reduce ? false : { opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduce ? undefined : { opacity: 0, y: -6 }}
                      transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                    >
                      {MATRIX[mode][i]}
                    </motion.span>
                  </AnimatePresence>
                </li>
              ))}
            </ul>

            <p className="perm__note">
              权限档位随会话持久化,重启后仍在;未声明访问类别的新工具默认走审批,不会静默放行。
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
