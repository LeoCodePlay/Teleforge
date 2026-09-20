// @引用图片的附件化:@local:/@remote: 过去只是正文里给模型的「路径提示」——多模态模型看不到
// 画面,generate_image 也拿不到附件 id,于是「@一张图,帮我改」这类请求无法完成。
// 这里在消息提交前把命中的图片引用读成字节、存进附件库,之后与「粘贴图片」走完全同一条链路:
// 请求期注入 image_url(见 agent.ts 的 materializeImageParts)+ 可用 reference_attachment_ids 作生图参考。
//
// 为什么由前端把 {source,path} 结构化上报、而不是服务端解析正文里的 @local:xxx:
// 路径本身可能含空格(如 "Wuthering Waves"),纯文本解析无法确定路径边界。
import path from 'node:path';
import { localFs } from '../core/local-fs.ts';
import { sshManager as ssh } from '../core/ssh-manager.ts';
import { saveAttachment, type AttachmentMeta } from '../store/attachments-store.ts';

// 只收栅格图:SVG 等矢量图部分提供方不接受 image_url,补进来反而让整轮请求报错
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp'
};

// 与 /api/attachments 的图片上限一致;超限不补,避免把上下文拖垮
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface MentionRef {
  source?: string;
  path?: string;
}

function imageMimeOf(p: string): string | null {
  const ext = (path.extname(p).split('.').pop() || '').toLowerCase();
  return IMAGE_MIME[ext] || null;
}

/**
 * 把 @ 引用里的图片文件读成附件。非图片引用原样跳过(仍由模型按路径用工具读取);
 * 单个文件读取失败也跳过,绝不因此中断整条消息。
 */
export async function resolveMentionImageAttachments(refs: MentionRef[]): Promise<AttachmentMeta[]> {
  const out: AttachmentMeta[] = [];
  const seen = new Set<string>();
  for (const ref of Array.isArray(refs) ? refs : []) {
    const p = String(ref?.path || '').trim();
    if (!p) continue;
    const source = ref?.source === 'remote' ? 'remote' : 'local';
    const key = `${source}:${p}`;
    if (seen.has(key)) continue; // 同一条消息里重复 @ 同一文件只补一次
    seen.add(key);
    const mime = imageMimeOf(p);
    if (!mime) continue;
    try {
      // maxBytes 多读 1 字节:据此判断是否超限(buffer 长度 > 上限即放弃)
      const read = source === 'remote'
        ? await ssh.readFileChunk(p, { maxBytes: MAX_IMAGE_BYTES + 1 })
        : await localFs.readFileChunk(p, { maxBytes: MAX_IMAGE_BYTES + 1 });
      if (!read?.buffer?.length || read.buffer.length > MAX_IMAGE_BYTES) continue;
      out.push(await saveAttachment(read.buffer, path.basename(p), mime));
    } catch { /* 读不到就跳过:引用仍以文本形式存在,模型可用工具自行处理 */ }
  }
  return out;
}
