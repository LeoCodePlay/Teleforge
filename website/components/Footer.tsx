import { asset } from '@/lib/asset';

const RELEASES = 'https://github.com/LeoCodePlay/Teleforge/releases';
const REPO = 'https://github.com/LeoCodePlay/Teleforge';
const README = 'https://github.com/LeoCodePlay/Teleforge/blob/master/README.md';

const COLS = [
  {
    t: '产品',
    links: [
      { label: '能力总览', href: '#capabilities' },
      { label: '权限模式', href: '#permission' },
      { label: '界面截图', href: '#shots' },
      { label: '快速开始', href: '#start' },
    ],
  },
  {
    t: '资源',
    links: [
      { label: '桌面端安装包', href: RELEASES },
      { label: '源码仓库', href: REPO },
      { label: '使用文档', href: README },
      { label: '常见问题', href: '#faq' },
    ],
  },
];

export function Footer() {
  return (
    <footer className="foot">
      <div className="wrap foot__inner">
        <div className="foot__brand">
          <div className="foot__lockup">
            <img src={asset('/teleforge-mark.svg')} alt="" width={14} height={23} />
            <span>Teleforge</span>
          </div>
          <p className="foot__note">
            本页截图来自真实运行的应用:远程服务端是一台本地 mock SSH 服务器,工作区是
            <span className="mono">/srv/ledger-api</span> 这个示例工程。
          </p>
        </div>

        {COLS.map((c) => (
          <nav className="foot__col" key={c.t} aria-label={c.t}>
            <span className="foot__ct mono">{c.t}</span>
            <ul>
              {c.links.map((l) => (
                <li key={l.label}>
                  <a
                    href={l.href}
                    {...(l.href.startsWith('http') ? { target: '_blank', rel: 'noreferrer' } : {})}
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="wrap foot__base">
        <span>GPL-3.0 开源 · Copyright (C) 2026 liaozhenqiang</span>
        <a className="mono foot__repo" href={REPO} target="_blank" rel="noreferrer">
          github.com/LeoCodePlay/Teleforge
        </a>
      </div>
    </footer>
  );
}
