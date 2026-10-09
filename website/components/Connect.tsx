import { Reveal } from './Reveal';
import { asset } from '@/lib/asset';

const POINTS = [
  {
    t: '连接保持与自动重连',
    d: '10 秒心跳保活;掉线后按 2s、4s、8s 的指数退避自动重连,顶栏实时显示状态。密码与私钥认证都支持。',
  },
  {
    t: '配置存在服务端',
    d: '主机、端口、用户、认证方式保存为命名配置,密码与私钥只留在服务端、不下发前端;下拉即可在多台服务器间切换。',
  },
  {
    t: '切换不打断正在跑的会话',
    d: '会话绑定它启动时的那台服务器,切走以后仍在后台继续执行,切回来内容一条不少。',
  },
  {
    t: '写操作以工作区为界',
    d: '连接后选任意目录作为工作区,Agent 的写入、编辑、删除都被限制在界内,并且禁止删除工作区根目录。',
  },
];

/** 第二节:连接与工作区。左侧文本 + 右侧两张真实面板叠放,打破对称 */
export function Connect() {
  return (
    <section className="section connect" id="connect">
      <div className="wrap connect__grid">
        <Reveal className="connect__copy">
          <h2 className="h2">
            先把连接做稳,
            <br />
            再谈自动化
          </h2>
          <p className="lede connect__lede">
            远程开发的失败大多出在连接上。Teleforge 把连接层单独做厚:保活、重连、多服务器、工作区边界,
            都放在 Agent 之下先解决掉。
          </p>

          <ul className="points">
            {POINTS.map((p) => (
              <li className="points__item" key={p.t}>
                <span className="points__dot" aria-hidden="true" />
                <div>
                  <h3 className="points__t">{p.t}</h3>
                  <p className="points__d">{p.d}</p>
                </div>
              </li>
            ))}
          </ul>

          <div className="retry" aria-hidden="true">
            <span className="retry__label mono">重连退避</span>
            <span className="retry__ladder">
              {['2s', '4s', '8s', '16s', '30s'].map((s) => (
                <span className="retry__step mono" key={s}>
                  {s}
                </span>
              ))}
              <span className="retry__pulse" />
            </span>
          </div>
        </Reveal>

        <Reveal className="connect__media" delay={0.08}>
          <figure className="shot shot--tall frame">
            <div className="frame__bar">
              <span className="frame__dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="frame__addr mono">/srv/ledger-api</span>
            </div>
            <img
              className="frame__shot"
              src={asset('/shots/files-panel.webp')}
              width={638}
              height={1092}
              loading="lazy"
              decoding="async"
              alt="远程文件面板:上方是远程与本地的目录浏览,下方列出 src、test、compose.yaml、package.json、README.md"
            />
          </figure>

          <figure className="shot shot--inset frame">
            <img
              className="frame__shot"
              src={asset('/shots/ssh-profiles.webp')}
              width={1120}
              height={624}
              loading="lazy"
              decoding="async"
              alt="SSH 连接面板:保持中的连接显示 prod-edge-01 已连接,下方是保存在服务端的服务器配置列表"
            />
          </figure>
        </Reveal>
      </div>
    </section>
  );
}
