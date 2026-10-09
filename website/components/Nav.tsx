'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion, useMotionValueEvent, useScroll, useSpring } from 'motion/react';
import { ArrowRightIcon, GitHubLogoIcon, MoonIcon, SunIcon } from '@radix-ui/react-icons';
import { asset } from '@/lib/asset';

const LINKS = [
  { href: '#capabilities', label: '能力' },
  { href: '#permission', label: '权限模式' },
  { href: '#shots', label: '界面截图' },
  { href: '#start', label: '快速开始' },
  { href: '#faq', label: '常见问题' },
];

const REPO = 'https://github.com/LeoCodePlay/Teleforge';
const RELEASES = 'https://github.com/LeoCodePlay/Teleforge/releases';

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  const { scrollY, scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 260, damping: 40, mass: 0.4 });

  useMotionValueEvent(scrollY, 'change', (v) => {
    const next = v > 14;
    setScrolled((prev) => (prev === next ? prev : next));
  });

  useEffect(() => {
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'light' ? 'light' : 'dark');
  }, []);

  const toggleTheme = useCallback(() => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('tf-theme', next);
    } catch {
      /* 隐私模式下写不了 localStorage,不影响本页 */
    }
    setTheme(next);
  }, []);

  return (
    <header className={`nav${scrolled ? ' is-scrolled' : ''}`}>
      <div className="wrap nav__inner">
        <a className="nav__brand" href="#top" aria-label="Teleforge 首页">
          <img className="nav__mark" src={asset('/teleforge-mark.svg')} alt="" width={15} height={25} />
          <span className="nav__word">Teleforge</span>
        </a>

        <nav className="nav__links" aria-label="主导航">
          {LINKS.map((l) => (
            <a key={l.href} className="nav__link" href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>

        <div className="nav__actions">
          <button
            type="button"
            className="nav__icon"
            onClick={toggleTheme}
            aria-label={theme === 'light' ? '切换到深色主题' : '切换到浅色主题'}
          >
            {theme === 'light' ? <MoonIcon /> : <SunIcon />}
          </button>
          <a className="nav__icon" href={REPO} target="_blank" rel="noreferrer" aria-label="GitHub 源码仓库">
            <GitHubLogoIcon />
          </a>
          <a className="btn btn--primary btn--sm nav__cta" href={RELEASES} target="_blank" rel="noreferrer">
            下载桌面端
          </a>
          <button
            type="button"
            className="nav__burger"
            aria-expanded={open}
            aria-label="打开菜单"
            onClick={() => setOpen((v) => !v)}
          >
            <i />
            <i />
          </button>
        </div>
      </div>

      <motion.div className="nav__progress" style={{ scaleX: progress }} aria-hidden="true" />

      {open && (
        <div className="nav__sheet">
          {LINKS.map((l) => (
            <a key={l.href} className="nav__sheet-link" href={l.href} onClick={() => setOpen(false)}>
              {l.label}
              <ArrowRightIcon />
            </a>
          ))}
          <a className="btn btn--primary" href={RELEASES} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
            下载桌面端
          </a>
          <a className="btn btn--ghost" href={REPO} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
            <GitHubLogoIcon /> 查看源码
          </a>
        </div>
      )}
    </header>
  );
}
