import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { BASE_PATH, SITE_ORIGIN } from '@/lib/asset';
import './globals.css';
import './sections.css';

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
  weight: ['400', '500'],
});

export const metadata: Metadata = {
  // 相对 URL(og:image 等)会基于它解析,必须带部署子路径
  metadataBase: new URL(`${SITE_ORIGIN}/`),
  title: 'Teleforge — 通过 SSH 让 AI 直接在服务器上写代码',
  description:
    '本地运行的 AI 编程工具:SSH 常驻连接远程主机,Agent 在远程工作区里真实读写文件、执行命令、搜索代码;未连接时在本机做同样的事。GPL-3.0 开源,支持 Windows / macOS / Linux。',
  keywords: ['Teleforge', 'SSH', 'AI 编程', '远程开发', 'AI Agent', '代码编辑器', 'Open Source'],
  authors: [{ name: 'liaozhenqiang' }],
  openGraph: {
    type: 'website',
    url: `${SITE_ORIGIN}/`,
    title: 'Teleforge — 通过 SSH 让 AI 直接在服务器上写代码',
    description:
      'SSH 常驻连接 + 远程 / 本地双工作区 + 真实工具调用。一个跑在本机、把 AI Agent 送进服务器里的编程工具。',
    images: [{ url: 'shots/app-overview.webp', width: 1920, height: 1200 }],
  },
  icons: { icon: `${BASE_PATH}/teleforge-mark.svg` },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0b0d10' },
    { media: '(prefers-color-scheme: light)', color: '#f6f7f9' },
  ],
  width: 'device-width',
  initialScale: 1,
};

/**
 * 首帧前定主题,避免闪白/闪黑。
 * 主题只在这里和 ThemeToggle 两处写,整页只有一个主题(不分区翻转)。
 */
const themeBootstrap = `(function(){try{
var s=localStorage.getItem('tf-theme');
var t=s||(window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');
document.documentElement.setAttribute('data-theme',t);
}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning className={`${geist.variable} ${geistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
