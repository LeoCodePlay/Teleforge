import { Reveal, RevealItem, RevealStagger } from './Reveal';
import { asset } from '@/lib/asset';

const TOOLS = [
  'run_command',
  'edit_file',
  'search_code',
  'browser_click',
  'subagent',
  'todo_write',
  'generate_image',
  'ask_user_question',
];

export function AgentBento() {
  return (
    <section className="section" id="capabilities">
      <div className="wrap">
        <Reveal className="sechead">
          <span className="eyebrow">AI AGENT</span>
          <h2 className="h2">
            对话就是执行,
            <br />
            每一步都留在记录里
          </h2>
        </Reveal>

        <RevealStagger className="bento">
          <RevealItem className="bento__cell bento__cell--shot">
            <figure className="bento__figure">
              <img
                className="bento__img"
                src={asset('/shots/agent-chat.webp')}
                width={1560}
                height={1376}
                loading="lazy"
                decoding="async"
                alt="对话区的过程分组:用户下达一条指令后,Agent 依次列出目录、读取文件、执行命令、写入文件"
              />
            </figure>
            <div className="bento__body">
              <h3 className="card__title">工具调用摊开给你看</h3>
              <p className="card__body">
                每一次读文件、改代码、跑命令都作为一条可展开的记录留在对话里:
                参数、输出、退出码、改动 diff 都能回看,不需要相信一段"我改好了"的总结。
              </p>
            </div>
          </RevealItem>

          <RevealItem className="bento__cell bento__cell--tools">
            <h3 className="card__title">十几个真实工具</h3>
            <p className="card__body">
              读操作并行执行,写操作互斥独占,调用顺序严格保持模型给出的顺序;工具可逐个启停并持久化。
            </p>
            <ul className="toollist mono">
              {TOOLS.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </RevealItem>

          <RevealItem className="bento__cell bento__cell--meter">
            <h3 className="card__title">上下文水位看得见</h3>
            <p className="card__body">
              优先采用提供方上报的真实 token 用量,网关不报时回退估算;悬浮可看系统提示词、工具调用与对话消息的分项。
            </p>
            <div className="meter" aria-hidden="true">
              <div className="meter__bar">
                <span className="meter__fill" style={{ width: '76%' }} />
                <span className="meter__mark" />
              </div>
              <div className="meter__legend mono">
                <span>已用 76%</span>
                <span>80% 自动压缩</span>
              </div>
            </div>
          </RevealItem>

          <RevealItem className="bento__cell bento__cell--refs">
            <h3 className="card__title">@ 引文件,/ 唤指令</h3>
            <p className="card__body">
              输入 <code className="kbd">@</code> 唤出工作区文件候选,选中即以完整路径发给模型;
              输入 <code className="kbd">/</code> 唤出压缩、计划、目标等系统命令与技能菜单。
            </p>
            <div className="refs mono" aria-hidden="true">
              <span>@src/ledger.js</span>
              <span>/compact</span>
            </div>
          </RevealItem>

          <RevealItem className="bento__cell bento__cell--sub">
            <h3 className="card__title">派个只读子代理去查</h3>
            <p className="card__body">
              大范围搜索交给独立上下文的调研子代理,它只能读、不能写;默认后台运行,
              跑完把结论回传,主对话不用干等。
            </p>
          </RevealItem>
        </RevealStagger>
      </div>
    </section>
  );
}
