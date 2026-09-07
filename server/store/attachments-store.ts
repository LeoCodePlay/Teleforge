// 聊天附件存储:粘贴/上传的图片、视频与文件落盘到 server/data/attachments/,
// 元数据(名称/MIME/大小/类别)记入同目录 index.json。会话事件日志只保存元数据,
// 模型多模态请求时按需读取字节转 base64 data URL —— 日志保持轻量、可回放。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ATTACHMENTS_DIR as ATTACH_DIR } from '../config.ts';
const INDEX_FILE = path.join(ATTACH_DIR, 'index.json');

export type AttachmentKind = 'image' | 'video' | 'file'; // 'video' 仅为旧数据保留:视频不再单独分类,新上传一律按文件处理

export interface AttachmentMeta {
  id: string;
  /** 展示名(仅 basename,不含路径) */
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  time: number;
}

// id -> 元数据(懒加载缓存);文件本身以 <id><原扩展名> 命名,内容寻址靠索引
let index: Record<string, AttachmentMeta> | null = null;

function loadIndex(): Record<string, AttachmentMeta> {
  if (index) return index;
  try {
    const j = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    index = j && typeof j === 'object' ? j : {};
  } catch {
    index = {};
  }
  return index;
}

function persistIndex() {
  try {
    fs.mkdirSync(ATTACH_DIR, { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  } catch (e: any) {
    console.error('保存附件索引失败:', e.message);
  }
}

const EXT_MIME: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', log: 'text/plain', csv: 'text/csv',
  json: 'application/json', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', ts: 'text/typescript',
  tsx: 'text/typescript', jsx: 'text/javascript', py: 'text/x-python', java: 'text/x-java',
  go: 'text/x-go', rs: 'text/x-rust', c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-c++',
  sh: 'text/x-shellscript', bat: 'text/x-shellscript', ps1: 'text/x-shellscript',
  html: 'text/html', css: 'text/css', sql: 'text/x-sql', php: 'text/x-php',
  rb: 'text/x-ruby', kt: 'text/x-kotlin', swift: 'text/x-swift'
};

export function classifyKind(mime: string, name: string): AttachmentKind {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  // 视频不再单独分类(已取消视频上传入口):与视频同等的二进制一律按普通文件处理
  const ext = (String(name || '').split('.').pop() || '').toLowerCase();
  const byExt = EXT_MIME[ext] || '';
  if (byExt.startsWith('image/')) return 'image';
  return 'file';
}

// 文本类文件(mime text/* 或已知代码扩展):小文件直接内联进模型上下文
export function isTextLike(mime: string, name: string): boolean {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('text/')) return true;
  if (m === 'application/json' || m === 'application/xml' || m === 'application/javascript' || m === 'application/yaml') return true;
  const ext = (String(name || '').split('.').pop() || '').toLowerCase();
  return !!EXT_MIME[ext];
}

function extOf(name: string): string {
  const ext = path.extname(String(name || ''));
  // 只保留安全短扩展名,防止奇怪字符进入文件名
  return /^\.[a-z0-9]{1,12}$/i.test(ext) ? ext.toLowerCase() : '';
}

/** 保存一个附件(字节已在内存);返回服务端权威元数据 */
export async function saveAttachment(buf: Buffer, name: string, mime: string): Promise<AttachmentMeta> {
  const idx = loadIndex();
  const id = 'att_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const base = String(name || '').split(/[\\/]/).filter(Boolean).pop() || '未命名';
  const meta: AttachmentMeta = {
    id,
    name: base.slice(0, 180),
    mime: String(mime || 'application/octet-stream'),
    size: buf.length,
    kind: classifyKind(mime, base),
    time: Date.now()
  };
  fs.mkdirSync(ATTACH_DIR, { recursive: true });
  await fsp.writeFile(path.join(ATTACH_DIR, id + extOf(base)), buf);
  idx[id] = meta;
  persistIndex();
  return meta;
}

export function getAttachment(id: string): AttachmentMeta | null {
  return loadIndex()[String(id)] || null;
}

export function attachmentPath(id: string): string | null {
  const meta = getAttachment(id);
  if (!meta) return null;
  const dirEntries = fs.existsSync(ATTACH_DIR) ? fs.readdirSync(ATTACH_DIR) : [];
  const hit = dirEntries.find((f) => f === id || f.startsWith(id + '.'));
  return hit ? path.join(ATTACH_DIR, hit) : null;
}

export function attachmentUrl(id: string): string {
  return `/api/attachments/${encodeURIComponent(String(id))}`;
}

// 图片 base64 内存缓存(请求每步都会重放历史中的图片,避免重复读盘);
// 超 32 条整体清空,简单有界
const b64Cache = new Map<string, string>();

/** 读取图片附件字节并转 base64 data URL(OpenAI image_url 格式);失败返回 null */
export async function readImageDataURL(id: string): Promise<string | null> {
  const hit = b64Cache.get(id);
  if (hit) return hit;
  const meta = getAttachment(id);
  if (!meta || meta.kind !== 'image') return null;
  const p = attachmentPath(id);
  if (!p) return null;
  try {
    const buf = await fsp.readFile(p);
    const mime = /^image\/[a-z0-9.+-]+$/i.test(meta.mime) ? meta.mime : 'application/octet-stream';
    const url = `data:${mime};base64,${buf.toString('base64')}`;
    if (b64Cache.size >= 32) b64Cache.clear();
    b64Cache.set(id, url);
    return url;
  } catch {
    return null;
  }
}
