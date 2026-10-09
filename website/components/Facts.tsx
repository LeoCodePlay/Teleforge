const FACTS = [
  { k: 'GPL-3.0', v: '开源许可,源码可审计' },
  { k: 'Node ≥ 22.18', v: '后端零编译,直接跑 TypeScript' },
  { k: '三平台', v: 'Windows / macOS / Linux 安装包' },
  { k: '20+', v: '预置模型提供方,可加自定义' },
  { k: '127.0.0.1', v: '默认只监听本机,不暴露到公网' },
];

/** 事实条:只写仓库里能核对的事实,不做"品牌墙"式装饰 */
export function Facts() {
  return (
    <section className="facts">
      <div className="wrap">
        <ul className="facts__row">
          {FACTS.map((f) => (
            <li className="facts__item" key={f.k}>
              <span className="facts__k mono">{f.k}</span>
              <span className="facts__v">{f.v}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
