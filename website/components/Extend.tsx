import { Reveal } from './Reveal';

const PROVIDERS = [
  'DeepSeek',
  'OpenAI',
  'Kimi',
  '智谱 GLM',
  '通义千问',
  '豆包',
  '千帆',
  '混元',
  '硅基流动',
  'Ollama',
  'vLLM',
  'Anthropic',
  'Gemini',
];

export function Extend() {
  return (
    <section className="section extend" id="extend">
      <div className="wrap">
        <Reveal className="extend__head">
          <h2 className="h2">模型、外部工具、技能,都有正经入口</h2>
          <p className="lede">
            不把能力写死在代码里:谁来推理、调用哪些外部服务、加载哪份指令,都在界面上改。
          </p>
        </Reveal>

        <div className="extend__grid">
          <Reveal className="extend__main">
            <h3 className="h3">模型接入</h3>
            <p className="extend__d">
              预置 20+ 主流提供方,协议覆盖 OpenAI 兼容、Anthropic Messages 与 Gemini 原生;
              也可以按名称、Base URL、模型清单和 Key 添加自己的端点,每个提供方记住上次用的模型。
              没配 Key 时还有 mock 模式可以离线把整条流程跑通。
            </p>
            <ul className="plist mono">
              {PROVIDERS.map((p) => (
                <li key={p}>{p}</li>
              ))}
              <li className="plist__more">20+ …</li>
            </ul>
          </Reveal>

          <Reveal className="extend__side" delay={0.06}>
            <div className="extend__block">
              <h3 className="h3">MCP 服务</h3>
              <p className="extend__d">
                设置里直接编辑一份 JSON 数组就能增删改外部 MCP server,保存即生效。
                支持 stdio 子进程与 Streamable HTTP;工具按 <code className="kbd">mcp__server__tool</code>
                进入模型工具列表,断线自动按指数退避重连。
              </p>
            </div>
            <div className="extend__block">
              <h3 className="h3">技能目录</h3>
              <p className="extend__d">
                内置技能、本机用户技能与工作区 <code className="kbd">.agents/skills/</code> 里的技能一起列出,
                来源优先级是工作区、本机、内置。Agent 通过 skill 工具按需加载 SKILL.md,而不是一开始就把全部指令塞进上下文。
              </p>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
