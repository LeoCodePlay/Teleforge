'use client';

import { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Reveal } from './Reveal';
import { asset } from '@/lib/asset';

type Mode = 'remote' | 'local';

const MODES: Record<Mode, { tab: string; title: string; desc: string; tools: string[]; note: string }> = {
  remote: {
    tab: '远程工作区',
    title: '接上服务器,就在服务器上动手',
    desc: '连接后浏览远程文件系统,把任意目录选为工作区。Agent 的读、写、改、删与命令执行全部发生在那一台主机上,命令输出流式回传。',
    tools: [
      'list_directory',
      'read_file',
      'write_file',
      'edit_file',
      'run_command',
      'search_code',
      'glob',
      'grep',
    ],
    note: '文件走 SFTP,命令走 SSH exec;写操作以工作区为界,越权由服务端拒绝。',
  },
  local: {
    tab: '本地工作区',
    title: '没连服务器,就在本机动手',
    desc: '未连接时进入本地模式。同一套界面、同一套流程,Agent 在你本机的目录上做完全相同的事,不必先架一台机器。',
    tools: [
      'list_local_dir',
      'read_local_file',
      'write_local_file',
      'edit_local_file',
      'run_local_command',
      'search_local_code',
      'glob_local',
      'grep_local',
    ],
    note: '本地终端是本机 PTY;本地写盘直接落盘,边界校验仍然在服务端执行。',
  },
};

export function DualWorkspace() {
  const [mode, setMode] = useState<Mode>('remote');
  const reduce = useReducedMotion();
  const m = MODES[mode];

  return (
    <section className="section dual" id="workspace">
      <div className="wrap">
        <Reveal className="dual__head">
          <h2 className="h2">同一套界面,两个工作区</h2>
          <p className="lede">
            远程和本地不是两个软件,而是同一套界面下的两种落地方式。切换工作区,工具集合随之切换,
            对话、文件、终端的位置一个都不用重新学。
          </p>
        </Reveal>

        <Reveal className="dual__switch" delay={0.05}>
          <div className="seg" role="tablist" aria-label="工作区模式">
            {(Object.keys(MODES) as Mode[]).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={mode === k}
                className={`seg__btn${mode === k ? ' is-on' : ''}`}
                onClick={() => setMode(k)}
              >
                {mode === k && (
                  <motion.span
                    layoutId="seg-pill"
                    className="seg__pill"
                    transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 34 }}
                  />
                )}
                <span className="seg__label">{MODES[k].tab}</span>
              </button>
            ))}
          </div>
        </Reveal>

        <Reveal className="dual__band" delay={0.08}>
          <figure className="frame">
            <div className="frame__bar">
              <span className="frame__dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="frame__addr mono">
                {mode === 'remote' ? 'ssh prod-edge-01 · /srv/ledger-api' : 'local · C:\\dev\\ledger-api'}
              </span>
            </div>
            <img
              className="frame__shot"
              src={asset('/shots/agent-tools.webp')}
              width={1520}
              height={490}
              loading="lazy"
              decoding="async"
              alt="Agent 在一轮对话里连续调用四个工具:列出目录、读取文件、运行命令、写入文件,每条都带参数与结果"
            />
          </figure>
        </Reveal>

        <Reveal className="dual__facts" delay={0.1}>
          <motion.div
            className="dual__text"
            key={mode}
            initial={reduce ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
          >
            <h3 className="h3">{m.title}</h3>
            <p className="dual__desc">{m.desc}</p>
            <p className="dual__note mono">{m.note}</p>
          </motion.div>

          <ul className="toolgrid">
            {m.tools.map((t, i) => (
              <motion.li
                className="toolgrid__cell mono"
                key={t}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: reduce ? 0 : i * 0.03, ease: [0.16, 1, 0.3, 1] }}
              >
                {t}
              </motion.li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
