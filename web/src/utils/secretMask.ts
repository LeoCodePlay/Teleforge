// 已发送用户文本里的凭据遮挡(移植 dsh 0.2.1-rc 的 `a93958c7d0 feat(ui-secret-mask)`)。
//
// 为什么需要:用户会把 API Key / 令牌 / 私钥 / 带密码的连接串直接粘进对话。
// 这条消息会长期留在历史里、出现在截图与共享屏幕上。遮挡只改变**显示**:
// 消息原文、复制结果、发给模型的请求仍是原字符(见 docs/dsh-delta-2026-10-17.md)。
//
// 识别范围严格限定在"有公开格式"的凭据上(前缀/结构可判定的):
//   模型服务 Key(sk-…、AIza…)、代码托管与包仓库令牌(ghp_/github_pat_/glpat-/npm_/hf_)、
//   云访问密钥 ID(AKIA/ASIA/LTAI/AKID)、协作与支付令牌(xox?-、sk_live_/rk_test_/whsec_)、
//   JWT(eyJ….….…)、PEM 私钥块、URL 里的密码。
// 刻意**不**识别 `password=…` 这类具名赋值与自然语言里的密码:同样的词会出现在
// 普通文本里(token 用量、变量名),误遮挡比漏遮挡更烦人。
export type SecretKind = 'token' | 'jwt' | 'keyblock' | 'urlpass';

/** 一段用户文本的渲染分段:普通文本原样,凭据段带被遮挡后的显示文本 */
export type SecretSeg =
  | { t: 'text'; v: string }
  | { t: 'secret'; v: string; raw: string; kind: SecretKind };

/** 令牌保留的前缀字符数(与 dsh 一致:留前 8 个,其余打码) */
const KEEP_PREFIX = 8;
/** 打码星号的上限:再长的令牌也不再按字符铺满(纯显示考虑,原文仍在 raw 里) */
const MAX_STARS = 24;

/**
 * 一条组合正则:从左到右取**最左**匹配,天然避免规则之间互相覆盖。
 * 顺序有意义 —— 私钥块必须最先(它的正文里可能含有像令牌的片段)。
 */
const MASTER = new RegExp(
  [
    // 1) PEM 私钥块:从 BEGIN 到对应的 END(含换行)
    String.raw`(?<key>-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----)`,
    // 2) URL 里的密码:scheme://user:password@host —— 只遮密码,用户名与主机保留
    String.raw`(?<url>[a-z][a-z0-9+.\-]*:\/\/[^\/\s:@]+:(?<pass>[^\/\s@]+)@)`,
    // 3) JWT:三段 base64url,以 eyJ(JSON 的 "{" 的 base64)开头
    String.raw`(?<jwt>\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})`,
    // 4) 前缀令牌:sk- 必须含数字(避免把 sk-learn 这类词当密钥)
    String.raw`(?<tok>\b(?:sk-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}`
      + String.raw`|AIza[0-9A-Za-z_-]{30,}`
      + String.raw`|ghp_[A-Za-z0-9]{30,}`
      + String.raw`|github_pat_[A-Za-z0-9_]{40,}`
      + String.raw`|glpat-[A-Za-z0-9_-]{18,}`
      + String.raw`|npm_[A-Za-z0-9]{30,}`
      + String.raw`|hf_[A-Za-z0-9]{30,}`
      + String.raw`|(?:AKIA|ASIA|LTAI|AKID)[A-Z0-9]{12,}`
      + String.raw`|xox[baprs]-[A-Za-z0-9-]{10,}`
      + String.raw`|whsec_[A-Za-z0-9]{20,}`
      + String.raw`|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})\b)`
  ].join('|'),
  'g'
);

/** 保留前 N 个字符,其余打码;超过上限的部分用省略号收尾(避免一行几十个星号) */
function maskKeepPrefix(raw: string, keep = KEEP_PREFIX): string {
  if (raw.length <= keep) return '*'.repeat(raw.length);
  const tail = raw.length - keep;
  return raw.slice(0, keep) + '*'.repeat(Math.min(tail, MAX_STARS)) + (tail > MAX_STARS ? '…' : '');
}

/** PEM 私钥块:保留首尾两行(BEGIN/END 本身不含密钥材料),正文整体收起 */
function maskKeyBlock(raw: string): string {
  const lines = raw.split('\n');
  if (lines.length <= 2) return maskKeepPrefix(raw, 0);
  const begin = lines[0];
  const end = lines[lines.length - 1].replace(/\s+$/, '');
  return `${begin}\n********(私钥正文已隐藏 ${lines.length - 2} 行)********\n${end}`;
}

/** URL 密码:全部遮挡(密码没有可保留的公共前缀) */
function maskUrlPassword(match: string, pass: string): string {
  return match.replace(pass, '*'.repeat(Math.min(pass.length, 12)) + (pass.length > 12 ? '…' : ''));
}

/**
 * 扫描用户文本,产出「文本 / 凭据」分段。
 * 纯函数、单趟扫描:同一段文本重复调用结果一致(渲染层可安全 memo)。
 */
export function splitSecrets(text: string): SecretSeg[] {
  const src = String(text ?? '');
  if (!src) return [];
  const out: SecretSeg[] = [];
  const re = new RegExp(MASTER.source, 'g'); // 每次新建,避免共享 lastIndex 被并发渲染打乱
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[0].length === 0) { re.lastIndex += 1; continue; } // 零宽匹配保险,避免死循环
    if (m.index > last) out.push({ t: 'text', v: src.slice(last, m.index) });
    const groups = m.groups ?? {};
    let kind: SecretKind = 'token';
    let masked = maskKeepPrefix(m[0]);
    if (groups.key !== undefined) { kind = 'keyblock'; masked = maskKeyBlock(m[0]); }
    else if (groups.url !== undefined) { kind = 'urlpass'; masked = maskUrlPassword(m[0], groups.pass ?? ''); }
    else if (groups.jwt !== undefined) { kind = 'jwt'; masked = maskKeepPrefix(m[0]); }
    out.push({ t: 'secret', v: masked, raw: m[0], kind });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ t: 'text', v: src.slice(last) });
  return out;
}

/** 文本里是否含有可识别的凭据(测试、提示用) */
export function hasSecret(text: string): boolean {
  return splitSecrets(text).some((s) => s.t === 'secret');
}

/** 遮挡后的纯文本(复制之外的只读展示场景,例如列表摘要) */
export function maskSecretsToText(text: string): string {
  return splitSecrets(text).map((s) => s.v).join('');
}
