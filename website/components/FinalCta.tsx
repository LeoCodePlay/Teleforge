import { ArrowRightIcon, DownloadIcon, GitHubLogoIcon } from '@radix-ui/react-icons';
import { Reveal } from './Reveal';

const RELEASES = 'https://github.com/LeoCodePlay/Teleforge/releases';
const REPO = 'https://github.com/LeoCodePlay/Teleforge';

export function FinalCta() {
  return (
    <section className="section cta">
      <div className="wrap">
        <Reveal className="cta__box">
          <span className="cta__glow" aria-hidden="true" />
          <div className="cta__inner">
            <h2 className="cta__title">
              把这套流程
              <br />
              装到你自己的服务器上
            </h2>
            <p className="lede cta__lede">
              一个跑在本机的工具,把 AI Agent 送进目标环境,做完事再回到你手里。
            </p>
            <div className="cta__actions">
              <a className="btn btn--primary" href={RELEASES} target="_blank" rel="noreferrer">
                <DownloadIcon className="btn__ico" />
                下载桌面端
              </a>
              <a className="btn btn--ghost" href={REPO} target="_blank" rel="noreferrer">
                <GitHubLogoIcon className="btn__ico" />
                查看源码
                <ArrowRightIcon className="btn__ico" />
              </a>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
