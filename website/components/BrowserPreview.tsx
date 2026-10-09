import { Reveal } from './Reveal';
import { asset } from '@/lib/asset';

const POINTS = [
  {
    t: '地址出现就能点',
    d: '命令输出里冒出 localhost:5173 这类地址时,顶栏会给出可点击的预览提示;聊天回复里的本地地址同样直接点开。',
  },
  {
    t: '链接不会把页面顶掉',
    d: 'http(s) 链接一律在内置预览标签里打开,桌面端不会把整个应用替换成目标网页;想交给系统浏览器,按住 Ctrl 或 Cmd 再点。',
  },
  {
    t: 'AI 操作的就是你看到的那一页',
    d: '服务端用真实 Chromium 推流画面,AI 取结构化快照、按 ref 精确点击与输入。一个预览只服务一个对话,归属在面板上写着。',
  },
  {
    t: '远程项目自动隧道',
    d: '工作区在远程服务器时,localhost:端口 会经现有 SSH 连接转发到本机回环端口再预览,不需要额外开端口。',
  },
];

export function BrowserPreview() {
  return (
    <section className="section browser" id="browser">
      <div className="wrap browser__grid">
        <Reveal className="browser__media">
          <figure className="frame">
            <div className="frame__bar">
              <span className="frame__dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="frame__addr mono">http://127.0.0.1:5173</span>
              <span className="chip">AI 可操控</span>
            </div>
            <img
              className="frame__shot"
              src={asset('/shots/browser-preview.webp')}
              width={1920}
              height={1366}
              loading="lazy"
              decoding="async"
              alt="内置浏览器预览标签:左侧是对话区,右侧预览面板左下角显示已连接的会话,工具栏标明 AI 可操控"
            />
          </figure>
        </Reveal>

        <Reveal className="browser__copy" delay={0.08}>
          <span className="eyebrow">BROWSER PREVIEW</span>
          <h2 className="h2">
            跑起来的前端,
            <br />
            在这里直接看、直接点
          </h2>
          <ul className="points points--tight">
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
        </Reveal>
      </div>
    </section>
  );
}
