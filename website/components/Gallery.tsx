'use client';

import { useCallback, useRef } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from '@radix-ui/react-icons';
import { Reveal } from './Reveal';
import { asset } from '@/lib/asset';

const SHOTS = [
  {
    src: '/shots/editor.webp',
    w: 2560,
    h: 1822,
    title: '代码编辑器',
    desc: '点开文本文件即以 CodeMirror 6 打开:语法高亮、行号、折叠、补全、搜索,Ctrl+S 写回原文件并保留原有行尾风格。',
    alt: 'CodeMirror 6 编辑器打开远程的 ledger.js,左侧是行号与语法高亮',
  },
  {
    src: '/shots/terminal.webp',
    w: 2560,
    h: 1822,
    title: '常驻终端',
    desc: '每个终端都是独立的真实 PTY 会话,各自保留屏幕缓冲与 shell 进程;可以同时开远程终端与本机终端,切换只是显示与隐藏。',
    alt: '终端标签:本地 PowerShell 会话执行 cd、node -v 与 dir 命令后的输出',
  },
  {
    src: '/shots/settings.webp',
    w: 1720,
    h: 1520,
    title: '设置与模型',
    desc: 'AI 配置、生图配置、主题、技能、工具插件、MCP 服务、全局指令集中在一处;自定义主题只要给六个颜色。',
    alt: '设置面板:左侧是分类导航,右侧是 AI 提供商卡片与模型列表',
  },
  {
    src: '/shots/mobile.webp',
    w: 780,
    h: 1688,
    title: '手机也能用',
    desc: '窄屏自动切到底部标签单栏布局,会话由抽屉唤出;文件管理支持长按右键菜单,编辑器会避让软键盘。',
    alt: '手机宽度下的 Teleforge:底部是 AI 助手、终端、项目的单栏标签',
  },
];

export function Gallery() {
  const trackRef = useRef<HTMLDivElement>(null);

  const scrollBy = useCallback((dir: 1 | -1) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.min(el.clientWidth * 0.8, 720), behavior: 'smooth' });
  }, []);

  return (
    <section className="section shots" id="shots">
      <div className="wrap shots__head">
        <h2 className="h2">界面的其他部分</h2>
        <div className="shots__nav">
          <button type="button" className="shots__btn" onClick={() => scrollBy(-1)} aria-label="向左浏览截图">
            <ChevronLeftIcon />
          </button>
          <button type="button" className="shots__btn" onClick={() => scrollBy(1)} aria-label="向右浏览截图">
            <ChevronRightIcon />
          </button>
        </div>
      </div>

      <Reveal className="shots__wrap">
        <div className="shots__track" ref={trackRef} tabIndex={0} aria-label="界面截图,可横向滚动">
          {SHOTS.map((s) => (
            <figure className="shotcard" key={s.src}>
              <div className="shotcard__media">
                <img
                  className="shotcard__img"
                  src={asset(s.src)}
                  width={s.w}
                  height={s.h}
                  loading="lazy"
                  decoding="async"
                  alt={s.alt}
                />
              </div>
              <figcaption className="shotcard__cap">
                <h3 className="shotcard__t">{s.title}</h3>
                <p className="shotcard__d">{s.desc}</p>
              </figcaption>
            </figure>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
