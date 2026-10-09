import { ArrowRightIcon, DownloadIcon } from '@radix-ui/react-icons';
import { HeroVisual } from './HeroVisual';

const RELEASES = 'https://github.com/LeoCodePlay/Teleforge/releases';
const REPO = 'https://github.com/LeoCodePlay/Teleforge';

export function Hero() {
  return (
    <section className="hero" id="top">
      <span className="hero__wash" aria-hidden="true" />
      <div className="wrap hero__grid">
        <div className="hero__copy">
          <h1 className="display hero__title">
            让 AI 直接在服务器上
            <br />
            读代码、改代码、跑命令
          </h1>
          <p className="lede hero__lede">
            Teleforge 用 SSH 常驻连接远程主机,Agent 在目标环境里真实读写文件、执行命令;
            没有连接时,它在本机做同样的事。
          </p>
          <div className="hero__cta">
            <a className="btn btn--primary" href={RELEASES} target="_blank" rel="noreferrer">
              <DownloadIcon className="btn__ico" />
              下载桌面端
            </a>
            <a className="btn btn--ghost" href={REPO} target="_blank" rel="noreferrer">
              查看源码
              <ArrowRightIcon className="btn__ico" />
            </a>
          </div>
        </div>

        <HeroVisual />
      </div>
    </section>
  );
}
