// 全局设置持久化(与会话存储分开,作用域为整台服务器/工作区,而非单个会话):
// - defaultPermissionMode:新会话的默认访问权限模式。用户任意会话里 permission_set 的档位
//   会同步到这里(计划模式除外),**新建**会话在创建时把它播种成自己的一条 permission/mode
//   事件(见 agent.ts 的 _pinDefaultPermission)。它只影响之后新建的会话,不会回溯改变已有
//   会话 —— 模式是会话级状态(见 permission.ts 的 foldPermissionMode 注释)。
// - imageTool:旧版「生图工具」的单条配置(url/key/model + 默认质量与尺寸),现已由
//   store/image-providers-store.ts 的多模型商列表取代;这里只保留**只读**解析,供该 store
//   首次加载时做一次性迁移。新配置不再写回本文件。
// - 落盘 data/settings.json(测试可注入 DATA_DIR 隔离目录),原子写防损坏(见 store/atomic-write.ts)。
import fs from 'node:fs';
import { DATA_DIR, SETTINGS_FILE } from '../config.ts';
import { writeFileAtomic } from './atomic-write.ts';

// 与 permission.ts 的 PERMISSION_MODES 保持一致(此处不复用 import,避免
// permission.ts -> settings-store.ts 的循环依赖)
const VALID_MODES = new Set(['confirm', 'auto-edit', 'plan', 'full-access']);

/**
 * 生图工具的接口方言:决定 /images/edits 提交参考图的形态。
 *  - image_array / image_single:multipart 表单,图片部件名为 image[] / image(OpenAI 官方口径);
 *  - json_base64:JSON 请求体,图片以 data URL 字符串放进 image(部分网关不收 multipart,
 *    实测 api.tk1688.com:带文件一律 400「reference image uploads are not supported」,
 *    而同一端点改发 JSON + base64 就能正常出图);
 *  - auto:按上面三种依次尝试,只在「请求形态被 4xx 拒绝」时降级(此时还没出图、不扣费)。
 */
export type ImageDialect = 'auto' | 'image_array' | 'image_single' | 'json_base64';
/** 合法的方言白名单(设置面板与配置文件回读共用) */
export const IMAGE_DIALECTS: string[] = ['auto', 'image_array', 'image_single', 'json_base64'];
export type ImageQuality = 'auto' | 'low' | 'medium' | 'high';
/** 质量档位白名单(显式 string[] 以便 .includes(任意字符串) 通过严格检查) */
export const IMAGE_QUALITIES: string[] = ['auto', 'low', 'medium', 'high'];

/**
 * 单条图像端点配置的公共字段(生图模型商在此基础上补 id / 名称 / 多 Key 状态)。
 * baseUrl 需含版本段(如 https://www.fucheers.top/v1、https://api.openai.com/v1),
 * 请求路径按 OpenAI 兼容约定拼成 {baseUrl}/images/generations 与 {baseUrl}/images/edits。
 * 旧版 settings.json 的 imageTool 也是这个形状,首次启动会自动迁移成一条模型商。
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
  writeFileAtomic(SETTINGS_FILE, body);
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
  const dialect: ImageDialect = IMAGE_DIALECTS.includes(r.dialect) ? r.dialect : 'auto';
  return { baseUrl, apiKey: String(r.apiKey || '').trim(), model, quality, size, dialect };
}

/** 读取旧版单条生图配置(只读);未配置或配置不完整返回 null。
 *  仅供 image-providers-store 首次加载时迁移到多模型商列表,新代码不要再用它。 */
export function getImageToolConfig(): ImageToolConfig | null {
  return sanitizeImageTool(readSettings().imageTool);
}
