// 聊天附件 UI(布局参照 deepseek-harness 的 ui-attachment):
// - AttachRail:输入框上方的草稿附件轨道 —— 64px 圆角缩略图卡、悬停露出删除钮、
//   横向溢出时两端翻页箭头(无滚动条)、点缩略图开灯箱看原图;
// - MessageAttachments:用户消息内的图片展示(harness MessageImage/ImageGallery 规则)——
//   单图长边 240px、比例钳制 [0.25,4]、超出裁剪且不放大小图;多图 64px 方块平铺;文件为图标 chip;
// - Lightbox:全屏遮罩灯箱(图片),Esc 或点击遮罩关闭。
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AttachmentInfo } from '../../types';
import './Attachments.scss';

/** 输入框草稿区的一个附件(上传完成前只有本地信息,完成后补 att.id) */
export interface ComposerAttachment {
  /** 本地唯一键(React key / 删除定位) */
  key: string;
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'file';
  /** 上传中(服务端 id 未就绪,发送按钮禁用) */
  uploading: boolean;
  error?: string;
  /** 上传成功后的服务端元数据 */
  att?: AttachmentInfo;
  /** 本地预览地址(图片 objectURL;文件为空) */
  previewUrl: string;
}

/** 按类型归类(服务端 classifyKind 的前端镜像):粘贴的截图可能没有 mime,按扩展名兜底。
 *  仅图片走视觉通道;视频等二进制一律按普通文件处理(随消息附路径说明) */
export function classifyKind(mime: string, name: string): 'image' | 'file' {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  const ext = (String(name || '').split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'heic'].includes(ext)) return 'image';
  return 'file';
}

export function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB';
  if (n >= 1024) return Math.round(n / 1024) + 'KB';
  return n + 'B';
}

// 已知文本/代码扩展(文件 chip 上展示扩展名徽标即可)
const extOf = (name: string) => (String(name || '').split('.').pop() || '').toUpperCase().slice(0, 5);

const IconClose = () => (
  <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
const IconFile = () => (
  <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    <path d="M14 3v4h4" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
);
const IconChevronLeft = () => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IconChevronRight = () => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** 灯箱内容源(图片) */
export interface LightboxSrc {
  src: string;
  alt: string;
}

export function Lightbox({ src, onClose }: { src: LightboxSrc | null; onClose: () => void }) {
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [src, onClose]);
  if (!src) return null;
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={src.alt} onClick={onClose}>
      <button type="button" className="lightbox-close" aria-label="关闭预览" onClick={onClose}><IconClose /></button>
      <img src={src.src} alt={src.alt} onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

/** 轨道单项内容:图片给真实缩略图,文件给扩展名卡;上传中转圈,失败显错误 */
function TileVisual({ item }: { item: ComposerAttachment }) {
  if (item.kind === 'image' && item.previewUrl) return <img src={item.previewUrl} alt={item.name} />;
  return (
    <span className="att-file-card" aria-hidden>
      <IconFile />
      <span className="att-file-ext">{extOf(item.name) || 'FILE'}</span>
    </span>
  );
}

/** 输入框上方草稿附件轨道(harness AttachmentRail 布局):
 * 溢出由两端箭头翻页(滚动条隐藏),新增项自动滚到末端露出 */
export function AttachRail({ items, onRemove, onOpen }: {
  items: ComposerAttachment[];
  onRemove: (item: ComposerAttachment) => void;
  onOpen: (item: ComposerAttachment) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<number | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    setEdges((prev) => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
      return prev.left === left && prev.right === right ? prev : { left, right };
    });
  }, []);
  useLayoutEffect(() => {
    const el = railRef.current;
    if (!el) return;
    // 新增附件:滚到末端露出它;轨道随会话恢复挂载(数量变少)不跳位
    if (countRef.current !== null && items.length > countRef.current) {
      el.scrollLeft = el.scrollWidth - el.clientWidth;
    }
    countRef.current = items.length;
    updateEdges();
  }, [items.length, updateEdges]);
  // 纵向滚轮在轨道上转为横向翻页(不透传给对话区)
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 60);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const page = (dir: -1 | 1) => {
    const el = railRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(el.clientWidth - 64, 200), behavior: 'smooth' });
  };
  return (
    <div className="att-rail">
      {edges.left && (
        <button type="button" className="att-arrow att-arrow-l" aria-label="向左翻页" onClick={() => page(-1)}><IconChevronLeft /></button>
      )}
      <div className="att-rail-track" ref={railRef} role="group" aria-label="待发送附件" onScroll={updateEdges}>
        {items.map((item) => (
          <div key={item.key} className={`att-item ${item.error ? 'err' : ''}`}>
            <button type="button" className="att-thumb" title={item.error || item.name}
              disabled={item.uploading}
              onClick={() => { if (!item.error && item.kind === 'image') onOpen(item); }}>
              {item.uploading ? <span className="att-spin" aria-label="上传中" /> : <TileVisual item={item} />}
            </button>
            <button type="button" className="att-remove" aria-label={`移除 ${item.name}`} onClick={() => onRemove(item)}>
              <IconClose />
            </button>
            {(item.kind !== 'image' || item.error) && (
              <span className="att-name" title={item.error || item.name}>{item.error ? '失败' : item.name}</span>
            )}
          </div>
        ))}
      </div>
      {edges.right && (
        <button type="button" className="att-arrow att-arrow-r" aria-label="向右翻页" onClick={() => page(1)}><IconChevronRight /></button>
      )}
    </div>
  );
}

// ---- 单图呈现(harness MessageImage 的 singleFit 规则)----
// 长边 240px;宽高比钳制到 [0.25, 4],超出部分 object-fit: cover 裁剪;
// 小图绝不放大(不超过原始尺寸);裁剪锚点:极高图贴顶部、极宽图贴左侧(信息通常在起始处)。
interface ImageFit { width: number; height: number; objectPosition: string }

function singleFit(naturalW: number, naturalH: number): ImageFit {
  const naturalRatio = naturalW / naturalH;
  const ratio = Math.min(4, Math.max(0.25, naturalRatio));
  const box = ratio >= 1
    ? { width: 240, height: 240 / ratio }
    : { width: 240 * ratio, height: 240 };
  const scale = Math.min(1, naturalW / box.width, naturalH / box.height);
  return {
    width: Math.max(1, Math.round(box.width * scale)),
    height: Math.max(1, Math.round(box.height * scale)),
    objectPosition: naturalRatio < 0.25 ? 'center top' : naturalRatio > 4 ? 'left center' : 'center'
  };
}

/** 单图消息:加载后按 singleFit 定尺寸;点击开灯箱(harness MessageImage) */
function MessageImageSingle({ att, onOpen }: {
  att: AttachmentInfo;
  onOpen: (src: LightboxSrc) => void;
}) {
  const url = att.url || `/api/attachments/${att.id}`;
  // null = 尺寸未测得(占位 240×160);测得后换成精确尺寸
  const [fit, setFit] = useState<ImageFit | null>(null);
  const onLoaded = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) setFit(singleFit(img.naturalWidth, img.naturalHeight));
  }, []);
  return (
    <button type="button" className="msg-att-img single"
      style={fit ? { width: fit.width, height: fit.height } : undefined}
      title={`查看 ${att.name}`}
      aria-label={`查看 ${att.name}`}
      onClick={() => onOpen({ src: url, alt: att.name })}>
      {!fit && <span className="msg-att-loading" aria-hidden>加载中…</span>}
      <img src={url} alt={att.name}
        style={fit ? { objectPosition: fit.objectPosition } : { position: 'absolute', width: 1, height: 1, opacity: 0 }}
        onLoad={onLoaded} />
    </button>
  );
}

/** 消息内附件展示(harness ImageGallery 规则):
 * 单图大图(singleFit),多图 64px 方块平铺;文件(含旧数据的 video)为 chip */
export function MessageAttachments({ items, onOpen }: {
  items: AttachmentInfo[];
  onOpen: (src: LightboxSrc) => void;
}) {
  if (!items.length) return null;
  const images = items.filter((a) => a.kind === 'image');
  const others = items.filter((a) => a.kind !== 'image');
  const single = images.length === 1 && others.length === 0;
  return (
    <div className="msg-att">
      {images.length > 0 && (
        <div className={`msg-att-gallery ${single ? 'single' : 'grid'}`}>
          {single ? (
            <MessageImageSingle att={images[0]} onOpen={onOpen} />
          ) : images.map((a) => {
            const url = a.url || `/api/attachments/${a.id}`;
            return (
              <button key={a.id} type="button" className="msg-att-img tile"
                title={`查看 ${a.name}`}
                onClick={() => onOpen({ src: url, alt: a.name })}>
                <img src={url} alt={a.name} loading="lazy" />
              </button>
            );
          })}
        </div>
      )}
      {others.map((a) => {
        const url = a.url || `/api/attachments/${a.id}`;
        return (
          <a key={a.id} className="msg-att-file" href={url} target="_blank" rel="noreferrer" title={`打开 ${a.name}`}>
            <IconFile />
            <span className="msg-att-file-main">
              <span className="msg-att-file-name">{a.name}</span>
              <span className="msg-att-file-meta">{extOf(a.name)} · {fmtSize(a.size)}</span>
            </span>
          </a>
        );
      })}
    </div>
  );
}
