'use client';

import { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { CheckIcon, CopyIcon, ExternalLinkIcon } from '@radix-ui/react-icons';
import { Reveal } from './Reveal';

type Tab = 'desktop' | 'source';

const RELEASES = 'https://github.com/LeoCodePlay/Teleforge/releases';
const DOCS = 'https://github.com/LeoCodePlay/Teleforge/blob/master/README.md';

const BLOCKS: Record<Tab, { title: string; lines: string[]; note: string }> = {
  desktop: {
    title: '桌面安装包',
    lines: [
      '# 从 GitHub Releases 下载对应平台的安装包',
      'https://github.com/LeoCodePlay/Teleforge/releases',
      '',
      '# 安装后直接可用,不依赖本机 Node',
      '# 新版本在「设置 → 关于与更新」里一键升级(Windows 支持自动安装)',
    ],
    note: '安装包不携带任何用户配置,首次运行会在系统应用数据目录里创建配置文件。',
  },
  source: {
    title: '源码运行',
    lines: [
      'npm install        # 安装依赖',
      'npm run build      # 构建前端,输出 web/dist',
      'npm start          # 启动服务 → http://127.0.0.1:4000',
      '',
      'npm run dev        # 开发模式:后端 :4000 + 前端热更新 :5173',
    ],
    note: '环境要求 Node.js ≥ 22.18;后端是纯 TypeScript,由 Node 直接运行,没有编译步骤。',
  },
};

export function QuickStart() {
  const [tab, setTab] = useState<Tab>('desktop');
  const [copied, setCopied] = useState(false);
  const reduce = useReducedMotion();
  const block = BLOCKS[tab];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.lines.join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板不可用时不做任何事,用户仍可手动选中 */
    }
  };

  return (
    <section className="section start" id="start">
      <div className="wrap start__grid">
        <Reveal className="start__copy">
          <span className="eyebrow">QUICK START</span>
          <h2 className="h2">
            两条路,
            <br />
            都直接进到工作界面
          </h2>
          <p className="lede">
            要省事就用安装包,要自己掌控就用源码跑。两条路进的都是同一个界面,
            默认只监听 127.0.0.1,不会把服务暴露到公网。
          </p>
          <div className="start__actions">
            <a className="btn btn--ghost" href={DOCS} target="_blank" rel="noreferrer">
              查看使用文档
              <ExternalLinkIcon className="btn__ico" />
            </a>
          </div>
        </Reveal>

        <Reveal className="start__panel" delay={0.06}>
          <div className="codewrap">
            <div className="codewrap__head">
              <div className="codewrap__tabs" role="tablist" aria-label="安装方式">
                {(Object.keys(BLOCKS) as Tab[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={tab === k}
                    className={`codewrap__tab${tab === k ? ' is-on' : ''}`}
                    onClick={() => setTab(k)}
                  >
                    {tab === k && (
                      <motion.span
                        layoutId="code-tab"
                        className="codewrap__tabpill"
                        transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 36 }}
                      />
                    )}
                    <span>{BLOCKS[k].title}</span>
                  </button>
                ))}
              </div>
              <button type="button" className="codewrap__copy" onClick={copy} aria-label="复制命令">
                {copied ? <CheckIcon /> : <CopyIcon />}
                <span>{copied ? '已复制' : '复制'}</span>
              </button>
            </div>

            <motion.pre
              className="codewrap__body"
              key={tab}
              initial={reduce ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
            >
              <code>{block.lines.join('\n')}</code>
            </motion.pre>

            <p className="codewrap__note">{block.note}</p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
