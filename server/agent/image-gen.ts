// 「生图」共享执行层。两条链路共用同一实现,避免语义漂移:
//  1) generate_image 工具 —— 文本模型在对话中调用(推荐路径:文本模型有对话历史,
//     能把"再亮一点""把帽子换蓝"解析成完整提示词,并自行决定文生图/图生图与尺寸质量);
//  2) imageGen 生图对话 —— 当前模型本身就是纯图像端点模型,整轮旁路到这里。
//
// 之所以单独成模块:tools.ts 不能反向 import agent.ts(循环依赖),
// 而两条链路都要用同一套「取参考图 → 调端点 → 落盘附件 → 生成摘要」逻辑。
import { LlmClient, type ImageInput } from './llm.ts';
import { getImageToolConfig, type ImageDialect, type ImageToolConfig } from '../store/settings-store.ts';
import { getAttachment, readImageBytes, saveAttachment, type AttachmentMeta } from '../store/attachments-store.ts';
import type { SessionEvent } from './session.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sshManager as ssh, joinRemote, type SshConnection } from '../core/ssh-manager.ts';
import { localFs } from '../core/local-fs.ts';
import { GENERATED_IMAGES_DIRNAME } from '../config.ts';

/** 一次生图执行的完整结果 */
export interface ImageJobResult {
  /** t2i=文生图(generations) / i2i=图生图或改图(edits) */
  mode: 't2i' | 'i2i';
  /** 实际提交给上游的提示词 */
  prompt: string;
  /** 真正送出的参考图张数 */
  refs: number;
  /** 被跳过的参考图 id(附件不存在、不是图片、或字节读不出) */
  skipped: string[];
  /** 成图落盘后的服务端元数据(下一轮据此回灌作参考图) */
  saved: AttachmentMeta[];
  /** 成图额外写入的工作区路径(远程/本地工作区下的 generated-images 目录);空 = 只留在会话附件里 */
  workspaceSaved: string[];
  /** 写入工作区失败的原因(不影响成图本身,已保留在会话附件中) */
  workspaceError?: string;
  /** 上游回显的实际尺寸(部分网关忽略请求的 size) */
  size?: string;
  /** 上游回显的实际模型名(网关可能别名路由) */
  upstreamModel?: string;
  /** 上游改写后的提示词 */
  revisedPrompt?: string;
  ms: number;
}

/** 未配置生图工具时给模型/用户的可操作提示 */
export const IMAGE_TOOL_MISSING =
  '生图工具尚未配置。请打开「设置 → 生图配置」,填写 Base URL、API Key 与模型名'
  + '(例如 Base URL=https://www.fucheers.top/v1、模型=gpt-image-2;或 OpenAI 官方 https://api.openai.com/v1、模型=gpt-image-1)。'
  + '配置完成后重试即可生图。';

// LlmClient 按配置缓存:每次生图新建客户端没必要,但配置一改就必须换实例
const clientCache = new Map<string, LlmClient>();

/** 由生图工具配置构造(或复用)一个指向图像端点的 LlmClient */
export function imageClientFor(cfg: ImageToolConfig): LlmClient {
  const key = `${cfg.baseUrl}|${cfg.model}|${cfg.apiKey.length}`;
  let c = clientCache.get(key);
  if (!c) {
    c = new LlmClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model });
    if (clientCache.size > 8) clientCache.clear();
    clientCache.set(key, c);
  }
  return c;
}

/** 读取已配置的生图工具;未配置返回 null(调用方负责给出 IMAGE_TOOL_MISSING 提示) */
export function resolveImageTool(): { cfg: ImageToolConfig; llm: LlmClient } | null {
  const cfg = getImageToolConfig();
  if (!cfg) return null;
  return { cfg, llm: imageClientFor(cfg) };
}

/** 会话内最近一张已生成的成图元数据(供下一轮作为图生图参考);无则 null */
export function lastGeneratedImage(events: SessionEvent[] | undefined | null): AttachmentMeta | null {
  for (let i = (events?.length || 0) - 1; i >= 0; i--) {
    const ev = events![i];
    if (ev?.type !== 'image/generated') continue;
    const atts = Array.isArray(ev.data?.attachments) ? ev.data.attachments : [];
    const hit = [...atts].reverse().find((a: any) => a && a.kind === 'image' && a.id);
    if (hit) return getAttachment(hit.id) || null;
  }
  return null;
}

/** 成图落盘为附件时的文件名:可读、可排序、不含路径分隔符 */
export function generatedImageName(seq: number, mime: string): string {
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'png';
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `生成图-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${seq > 1 ? `-${seq}` : ''}.${ext}`;
}

/** 成图摘要文本(写进日志,前端气泡正文与切回文本模型时的历史都用它) */
export function imageCaption(d: { mode: 't2i' | 'i2i'; refs?: number; size?: string; count?: number }): string {
  const how = d.mode === 'i2i' ? `图生图${d.refs ? `·参考 ${d.refs} 张` : ''}` : '文生图';
  const size = d.size ? ` · ${String(d.size).replace('x', '×')}` : '';
  return `已生成 ${d.count || 1} 张图片(${how}${size})`;
}

/** 请求被上游以"参数/字段不接受"类 4xx 拒绝(尚未出图、不产生扣费),可安全换方言重试 */
function isRequestShapeError(e: any): boolean {
  const s = String(e?.message || '');
  if (!/\bHTTP (400|404|405|415|422)\b/.test(s)) return false;
  return /image|field|file|param|unsupported|invalid|unknown|not\s+support|缺少|不支持/i.test(s);
}

/**
 * 成图在工作区里的落盘目标:
 *  - 远程工作区已选择 → 远程(经 SFTP 上传到该连接的工作区);
 *  - 否则本地工作区已选择 → 本地;
 *  - 都没有(含「不在工作区对话」)→ null,成图只留在会话附件里。
 * 远程必须先有真正绑定的连接:本地会话下 ssh.workspace 可能回落到连接级残留值。
 */
type GeneratedImagesTarget =
  | { kind: 'remote'; conn: SshConnection; dir: string }
  | { kind: 'local'; dir: string };

function generatedImagesTarget(): GeneratedImagesTarget | null {
  const conn = ssh.active;
  const remoteWs = conn ? ssh.workspace : null;
  if (conn && remoteWs) return { kind: 'remote', conn, dir: joinRemote(remoteWs, GENERATED_IMAGES_DIRNAME) };
  const localWs = localFs.workspace;
  if (localWs) return { kind: 'local', dir: path.join(localWs, GENERATED_IMAGES_DIRNAME) };
  return null;
}

/** 把成图字节写入工作区专用目录;返回写入后的完整路径。失败抛错,由调用方降级为警告 */
async function writeToWorkspace(target: GeneratedImagesTarget, name: string, buf: Buffer): Promise<string> {
  const dest = target.kind === 'remote' ? joinRemote(target.dir, name) : path.join(target.dir, name);
  if (target.kind === 'remote') {
    await target.conn.writeRemoteFile(dest, buf, { maxBytes: 0 });
  } else {
    await fs.mkdir(target.dir, { recursive: true });
    await fs.writeFile(dest, buf);
  }
  return dest;
}

/**
 * 执行一次生图:解析参考图 → 调端点 → 成图落盘为附件。
 * 关键约定:
 *  - 参考图只认服务端附件索引里的图片(调用方给的 id 一律重新校验,防伪造与越权读盘);
 *  - 上游按张计费,失败不自动重试;唯一的例外是"请求形态被 4xx 拒绝"(此时还没出图、
 *    不会扣费),允许把 edits 的参考图字段在 image[] / image 之间换一种方言重试一次。
 */
export async function runImageJob({
  llm, prompt, refIds = [], useLastImage = false, events, quality, size, dialect = 'auto', signal
}: {
  llm: LlmClient;
  prompt: string;
  refIds?: string[];
  /** true 时自动取本会话上一张成图作参考(改图场景) */
  useLastImage?: boolean;
  /** useLastImage 需要的会话事件日志 */
  events?: SessionEvent[] | null;
  quality?: string;
  size?: string;
  dialect?: ImageDialect;
  signal?: AbortSignal;
}): Promise<ImageJobResult> {
  const t0 = Date.now();
  const wanted: string[] = [];
  const skipped: string[] = [];
  for (const id of refIds) {
    const clean = String(id || '').trim();
    if (!clean) continue;
    const meta = getAttachment(clean);
    if (!meta || meta.kind !== 'image') { skipped.push(clean); continue; }
    wanted.push(clean);
  }
  if (!wanted.length && useLastImage) {
    const prev = lastGeneratedImage(events);
    if (prev) wanted.push(prev.id);
  }
  const refs: ImageInput[] = [];
  for (const id of wanted) {
    const b = await readImageBytes(id);
    if (b) refs.push(b); else skipped.push(id);
  }
  const useEdits = refs.length > 0;
  const mode: 't2i' | 'i2i' = useEdits ? 'i2i' : 't2i';
  const q = quality && quality !== 'auto' ? quality : (quality === 'auto' ? 'auto' : undefined);
  const sz = size && size !== 'auto' ? size : undefined;

  let imgs;
  if (!useEdits) {
    imgs = await llm.generateImage({ prompt, quality: q, size: sz, signal });
  } else {
    const firstField: 'image[]' | 'image' = dialect === 'image_single' ? 'image' : 'image[]';
    try {
      imgs = await llm.editImage({ prompt, images: refs, quality: q, size: sz, imageField: firstField, signal });
    } catch (e: any) {
      // 多张参考图只有 gpt-image 系列的 image[] 支持,换单数字段会丢图,不做降级重试
      const other = firstField === 'image[]' ? 'image' : 'image[]';
      if (dialect !== 'auto' || refs.length > 1 || other !== 'image' || !isRequestShapeError(e)) throw e;
      imgs = await llm.editImage({ prompt, images: refs, quality: q, size: sz, imageField: 'image', signal });
    }
  }

  const saved: AttachmentMeta[] = [];
  const workspaceSaved: string[] = [];
  let workspaceError: string | undefined;
  const target = generatedImagesTarget();
  for (let i = 0; i < imgs.length; i++) {
    const name = generatedImageName(i + 1, imgs[i].mime);
    saved.push(await saveAttachment(imgs[i].buf, name, imgs[i].mime));
    if (target) {
      try { workspaceSaved.push(await writeToWorkspace(target, name, imgs[i].buf)); }
      catch (e: any) {
        workspaceError = e?.message || String(e);
        console.error('[image-gen] 成图写入工作区失败:', workspaceError);
      }
    }
  }
  return {
    mode, prompt, refs: refs.length, skipped, saved, workspaceSaved,
    ...(workspaceError ? { workspaceError } : {}),
    size: imgs[0]?.size, upstreamModel: imgs[0]?.model, revisedPrompt: imgs[0]?.revisedPrompt,
    ms: Date.now() - t0
  };
}
