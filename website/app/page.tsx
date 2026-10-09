import { Nav } from '@/components/Nav';
import { Hero } from '@/components/Hero';
import { Facts } from '@/components/Facts';
import { Connect } from '@/components/Connect';
import { DualWorkspace } from '@/components/DualWorkspace';
import { AgentBento } from '@/components/AgentBento';
import { ContextMeter } from '@/components/ContextMeter';
import { Permissions } from '@/components/Permissions';
import { BrowserPreview } from '@/components/BrowserPreview';
import { Gallery } from '@/components/Gallery';
import { Extend } from '@/components/Extend';
import { QuickStart } from '@/components/QuickStart';
import { Faq } from '@/components/Faq';
import { FinalCta } from '@/components/FinalCta';
import { Footer } from '@/components/Footer';

/**
 * SSR 页面:除标注 'use client' 的动效岛(导航、首屏视觉、滚动示意图、交互选择器)之外,
 * 全部在服务端渲染成 HTML,首屏不依赖 JavaScript 就能读到完整内容。
 */
export default function Page() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Facts />
        <Connect />
        <div className="wrap">
          <hr className="hairline" />
        </div>
        <DualWorkspace />
        <AgentBento />
        <ContextMeter />
        <Permissions />
        <BrowserPreview />
        <Gallery />
        <div className="wrap">
          <hr className="hairline" />
        </div>
        <Extend />
        <QuickStart />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
