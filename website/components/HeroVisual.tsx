'use client';

import { useRef } from 'react';
import { motion, useMotionValue, useReducedMotion, useScroll, useSpring, useTransform } from 'motion/react';
import { asset } from '@/lib/asset';

/**
 * 首屏视觉:应用真实截图 + 窗口外框。
 * 动效有三处动机:
 *  1) 入场由缩放/透明度完成 —— 交代"应用启动"的层次顺序;
 *  2) 滚动视差 —— 让视觉层与文字层分离出纵深;
 *  3) 指针微倾 —— 对"这是我可以用手操作的工具"给出反馈。
 * 全部只动 transform / opacity,且所有动效值都落在 [0,1] 的合法区间内;
 * reduced-motion 下整体退化为静态。
 */
export function HeroVisual() {
  const reduce = useReducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: wrapRef,
    offset: ['start 0.92', 'end start'],
  });
  const lift = useTransform(scrollYProgress, [0, 1], [0, -34]);

  // 指针 → 倾角:直接写入 MotionValue,不在渲染周期里做任何 setState
  const tiltX = useMotionValue(0);
  const tiltY = useMotionValue(0);
  const rotateX = useSpring(tiltX, { stiffness: 150, damping: 18 });
  const rotateY = useSpring(tiltY, { stiffness: 150, damping: 18 });

  return (
    <motion.div
      ref={wrapRef}
      className="hero__visual"
      style={reduce ? undefined : { y: lift }}
      onPointerMove={
        reduce
          ? undefined
          : (e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const nx = (e.clientX - r.left) / r.width - 0.5;
              const ny = (e.clientY - r.top) / r.height - 0.5;
              tiltX.set(ny * 6);
              tiltY.set(-nx * 8);
            }
      }
      onPointerLeave={
        reduce
          ? undefined
          : () => {
              tiltX.set(0);
              tiltY.set(0);
            }
      }
    >
      <motion.div
        className="hero__tilt"
        style={reduce ? undefined : { rotateX, rotateY }}
        initial={reduce ? false : { opacity: 0, y: 26, scale: 0.975 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.95, delay: 0.18, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="frame hero__frame">
          <div className="frame__bar">
            <span className="frame__dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="frame__addr">127.0.0.1:4000</span>
            <span className="hero__live">
              <span className="dot" />
              已连接
            </span>
          </div>
          <img
            className="frame__shot"
            src={asset('/shots/app-overview.webp')}
            width={1920}
            height={1200}
            alt="Teleforge 主界面:左侧是会话列表与远程文件管理,中间是 AI 助手的工具调用记录,右侧是终端与预览面板"
            fetchPriority="high"
            decoding="async"
          />
          <span className="hero__sweep" aria-hidden="true" />
        </div>
      </motion.div>
    </motion.div>
  );
}
