'use client';

import { useRef } from 'react';
import { motion, useReducedMotion, useScroll, useTransform, type MotionValue } from 'motion/react';

const STEPS = [
  {
    from: 0.08,
    to: 0.42,
    t: '水到 80%,自动压缩',
    d: '按模型声明的窗口实时估算水位,超过可用窗口的 80% 就把早期对话压成摘要再继续,不需要你手动开新会话。',
  },
  {
    from: 0.36,
    to: 0.7,
    t: '对齐工具配对边界',
    d: '压缩区间按位置挑选,并与工具调用配对边界对齐,所以一条指令引发的长任务也能中途压缩,不会切出半截调用。',
  },
  {
    from: 0.64,
    to: 0.98,
    t: '压缩失败就降级裁剪',
    d: '摘要生成失败时自动退化为裁剪,保留下原始任务锚点;并在对话流里留一条"上下文压缩"标记,点开能看摘要。',
  },
];

/** 一个滚动驱动的示意图:水位上涨 → 触发压缩 → 水位回落 → 继续推进 */
function StepItem({ p, step }: { p: MotionValue<number>; step: (typeof STEPS)[number] }) {
  // 所有区间都收敛在 [0,1] 内(WAAPI 的 offset 契约要求)
  const opacity = useTransform(
    p,
    [step.from, step.from + 0.05, step.to - 0.05, step.to],
    [0.4, 1, 1, 0.4]
  );
  const x = useTransform(p, [Math.max(0, step.from - 0.06), step.from], [-8, 0]);
  return (
    <motion.li className="steps__item" style={{ opacity, x }}>
      <h3 className="steps__t">{step.t}</h3>
      <p className="steps__d">{step.d}</p>
    </motion.li>
  );
}

export function ContextMeter() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });

  // 水位:0 → 0.8(涨) → 0.34(压缩后回落) → 0.74(继续推进)
  const level = useTransform(scrollYProgress, [0, 0.3, 0.48, 0.68, 1], [0.12, 0.8, 0.8, 0.34, 0.74]);
  const scaleY = level;

  const earlyOpacity = useTransform(scrollYProgress, [0.3, 0.44, 0.62, 0.78], [1, 1, 0, 0]);
  const earlyY = useTransform(scrollYProgress, [0.34, 0.5, 0.66], [0, -18, -34]);
  const summaryOpacity = useTransform(scrollYProgress, [0.46, 0.56, 0.9, 1], [0, 1, 1, 1]);
  const summaryY = useTransform(scrollYProgress, [0.46, 0.58], [14, 0]);
  const markerOpacity = useTransform(scrollYProgress, [0.42, 0.5, 0.86, 0.95], [0, 1, 1, 0.5]);
  const lateScale = useTransform(scrollYProgress, [0.6, 1], [0.985, 1]);

  if (reduce) {
    return (
      <section className="section ctx-static" id="context">
        <div className="wrap">
          <h2 className="h2">长任务跑到一半断掉,两种断法都在这里堵住</h2>
          <ul className="steps steps--static">
            {STEPS.map((s) => (
              <li className="steps__item" key={s.t}>
                <h3 className="steps__t">{s.t}</h3>
                <p className="steps__d">{s.d}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>
    );
  }

  return (
    <section className="ctx" id="context" ref={ref}>
      <div className="ctx__sticky">
        <div className="wrap ctx__grid">
          <div className="ctx__copy">
            <h2 className="h2">
              长任务跑到一半断掉,
              <br />
              两种断法都在这里堵住
            </h2>
            <ul className="steps">
              {STEPS.map((s) => (
                <StepItem key={s.t} p={scrollYProgress} step={s} />
              ))}
            </ul>
          </div>

          <div className="ctxw" aria-hidden="true">
            <div className="ctxw__head">
              <span className="mono">上下文窗口</span>
              <span className="ctxw__thr mono">压缩阈值 80%</span>
            </div>

            <div className="ctxw__body">
              <span className="ctxw__limit" style={{ bottom: '80%' }} />
              <motion.span className="ctxw__level" style={{ scaleY, originY: 1 }} />

              <motion.div className="ctxw__early" style={{ opacity: earlyOpacity, y: earlyY }}>
                <span className="blk blk--sys">系统提示词 · 工具 schema</span>
                <span className="blk blk--tool">早期工具结果(已折叠)</span>
                <span className="blk blk--tool">早期工具结果(已折叠)</span>
              </motion.div>

              <motion.div className="ctxw__summary" style={{ opacity: summaryOpacity, y: summaryY }}>
                <span className="mono">上下文压缩</span>
                <span>早期对话已压缩为摘要,原始任务锚点保留</span>
              </motion.div>

              <motion.div className="ctxw__late" style={{ scale: lateScale }}>
                <span className="blk">最近的对话消息</span>
                <span className="blk blk--tool">本步工具调用</span>
              </motion.div>

              <motion.span className="ctxw__marker" style={{ opacity: markerOpacity }}>
                压缩发生在这里
              </motion.span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
