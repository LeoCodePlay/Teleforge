'use client';

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { PlusIcon } from '@radix-ui/react-icons';
import { Reveal } from './Reveal';

const QA = [
  {
    q: '远程服务器上要装什么吗?',
    a: '不用。只要 SSH 能连上,读写走 SFTP、命令走 exec,远端不需要安装 Node 或本工具的任何组件。你自己的项目依赖照旧由项目自己管理。',
  },
  {
    q: '我的代码和对话会被传到哪里?',
    a: '除了你自己配置的模型提供方(对话内容必须发给他才能推理),所有操作与数据都只发生在运行本机和连接的服务器上,不上传给作者或其他第三方。API Key 只保存在本机。',
  },
  {
    q: '会不会把服务器改坏?',
    a: '写、改、删都被限制在所选工作区内,并且禁止删除工作区根目录;默认的确认档位下,每次写入与命令都要你点一次批准;毁灭性命令还有一层独立拦截。建议用单独的低权限账号加密钥登录。',
  },
  {
    q: '支持哪些模型?',
    a: '预置 DeepSeek、OpenAI、Kimi、智谱、通义、豆包、千帆、混元、硅基流动、本地 Ollama 与 vLLM 等 20 多个提供方,也可以填自己的 OpenAI 兼容端点、Anthropic Messages 或 Gemini 原生协议。',
  },
  {
    q: '收费吗?',
    a: 'Teleforge 以 GPL-3.0 开源,软件本身免费。唯一的成本是你自己调用模型 API 产生的费用,那部分直接结算给你选择的提供方。',
  },
];

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  const reduce = useReducedMotion();

  return (
    <section className="section faq" id="faq">
      <div className="wrap faq__grid">
        <Reveal className="faq__head">
          <h2 className="h2">常见问题</h2>
          <p className="lede">权限边界、数据流向和运行依赖,这里一次说清楚。</p>
        </Reveal>

        <Reveal className="faq__list" delay={0.06}>
          {QA.map((item, i) => {
            const on = open === i;
            return (
              <div className={`faq__item${on ? ' is-open' : ''}`} key={item.q}>
                <h3 className="faq__h">
                  <button
                    type="button"
                    className="faq__btn"
                    aria-expanded={on}
                    onClick={() => setOpen(on ? null : i)}
                  >
                    <span>{item.q}</span>
                    <span className="faq__ico" aria-hidden="true">
                      <PlusIcon />
                    </span>
                  </button>
                </h3>
                <AnimatePresence initial={false}>
                  {on && (
                    <motion.div
                      className="faq__body"
                      initial={reduce ? false : { height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={reduce ? undefined : { height: 0, opacity: 0 }}
                      transition={{ duration: 0.34, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <p>{item.a}</p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </Reveal>
      </div>
    </section>
  );
}
