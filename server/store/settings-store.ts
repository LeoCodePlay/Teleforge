// 全局设置持久化(与会话存储分开,作用域为整台服务器/工作区,而非单个会话):
// - defaultPermissionMode:默认访问权限模式。用户任意会话里 permission_set 的档位会
//   同步到这里,新会话继承该默认值(见 agent.ts 的 getPermissionMode / permission.ts 的
//   foldPermissionMode fallback)。
// - imageTool:「生图工具」独立配置(url/key/model + 默认质量与尺寸)。它与对话所用的
//   LLM 提供商完全解耦 —— 对话可以是任意文本模型,生图另指一个图像端点。
// - 落盘 data/settings.json(测试可注入 DATA_DIR 隔离目录),原子写防损坏。
import fs from 'node:fs';
import { DATA_DIR, SETTINGS_FILE } from '../config.ts';

// 与 permission.ts 的 PERMISSION_MODES 保持一致(此处不复用 import,避免
// permission.ts -> settings-store.ts 的循环依赖)
const VALID_MODES = new Set(['confirm', 'auto-edit', 'plan', 'full-access']);

/** 生图工具的接口方言:决定 /images/edits 提交参考图的字段形态 */
export type ImageDialect = 'auto' | 'image_array' | 'image_single';
export type ImageQuality = 'auto' | 'low' | 'medium' | 'high';
/** 质量档位白名单(显式 string[] 以便 .includes(任意字符串) 通过严格检查) */
export const IMAGE_QUALITIES: string[] = ['auto', 'low', 'medium', 'high'];

/**
 * 「生图工具」配置(供 generate_image 工具与 imageGen 生图对话共用)。
 * baseUrl 需含版本段(如 https://www.fucheers.top/v1、https://api.openai.com/v1),
 * 请求路径按 OpenAI 兼容约定拼成 {baseUrl}/images/generations 与 {baseUrl}/images/edits。
 */
export interface ImageToolConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 默认质量;工具调用未显式指定时使用 */
  quality: ImageQuality;
  /** 默认尺寸(WxH 或 auto);工具调用未显式指定时使用 */
  size: string;
  dialect: ImageDialect;
}

function readSettings(): any {
  let j: any;
  try { j = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { j = null; }
  return j && typeof j === 'object' ? j : {};
}

// 合并写:只覆盖传入的键,保留文件里其他设置项。
// (原实现固定写 {version, defaultPermissionMode},新增设置项后被它整体抹掉)
function writeSettings(patch: Record<string, any>) {
  const cur = readSettings();
  const next = { ...cur, version: 1, ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const body = JSON.stringify(next, null, 0);
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
}

/** 全局默认访问权限模式(新会话继承;未设置/脏数据回落 'confirm') */
export function getDefaultPermissionMode(): string {
  const m = readSettings().defaultPermissionMode;
  return VALID_MODES.has(m) ? m : 'confirm';
}

/** 持久化全局默认访问权限模式(调用方已校验模式值) */
export function setDefaultPermissionMode(mode: string): void {
  writeSettings({ defaultPermissionMode: VALID_MODES.has(mode) ? mode : 'confirm' });
}

/** 可选尺寸(值=上游 WxH 参数,label=用户口径);前端配置面板与工具 schema 同源此处 */
export const IMAGE_SIZE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: '自动(由上游决定)' },
  { value: '1024x1024', label: '1K 方图 1024×1024' },
  { value: '1536x1024', label: '1.5K 横图 1536×1024' },
  { value: '1024x1536', label: '1.5K 竖图 1024×1536' },
  { value: '2048x2048', label: '2K 方图 2048×2048' },
  { value: '3072x3072', label: '3K 方图 3072×3072' },
  { value: '3840x2160', label: '4K 横图 3840×2160' },
  { value: '2160x3840', label: '4K 竖图 2160×3840' }
];
export const IMAGE_SIZES: string[] = IMAGE_SIZE_OPTIONS.map((o) => o.value);

const IMG_SIZES = new Set(IMAGE_SIZES);

/** 净化生图工具配置:非法/缺项返回 null(= 未配置);baseUrl 必须带协议 */
export function sanitizeImageTool(raw: unknown): ImageToolConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, any>;
  const baseUrl = String(r.baseUrl || '').trim().replace(/\/+$/, '');
  const model = String(r.model || '').trim();
  // 三项缺一不可:没有端点或模型名的配置无法工作,按"未配置"处理
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl) || !model) return null;
  const quality = IMAGE_QUALITIES.includes(r.quality) ? r.quality : 'auto';
  const size = IMG_SIZES.has(String(r.size || '')) ? String(r.size) : 'auto';
  const dialect: ImageDialect = (['auto', 'image_array', 'image_single'] as string[]).includes(r.dialect) ? r.dialect : 'auto';
  return { baseUrl, apiKey: String(r.apiKey || '').trim(), model, quality, size, dialect };
}

/** 读取生图工具配置;未配置或配置不完整返回 null */
export function getImageToolConfig(): ImageToolConfig | null {
  return sanitizeImageTool(readSettings().imageTool);
}

/** 保存生图工具配置;传入非法值时抛错(由调用方转成 HTTP 400) */
export function setImageToolConfig(raw: unknown): ImageToolConfig | null {
  const cfg = sanitizeImageTool(raw);
  if (raw && cfg === null) throw new Error('生图工具配置不完整:Base URL(需 http(s):// 开头)与模型名均为必填');
  writeSettings({ imageTool: cfg });  // cfg=null 即清除配置
  return cfg;
}

/** 配置摘要(供前端展示:不回传 apiKey 明文以外的敏感字段之外的信息) */
export function imageToolSummary(): (ImageToolConfig & { configured: boolean }) | null {
  const cfg = getImageToolConfig();
  return cfg ? { ...cfg, configured: true } : null;
}
