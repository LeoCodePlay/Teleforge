// splitSecrets / maskSecretsToText 单测:凭据遮挡的识别范围与遮挡形态。
// 背景(上游 dsh 0.2.1-rc 的 a93958c7d0):用户会把 Key/令牌/私钥/带密码的连接串直接粘进对话,
// 这些消息会长期留在历史里、出现在截图与共享屏幕上。遮挡只改显示,原文/复制/发给模型的都保留。
import { splitSecrets, hasSecret, maskSecretsToText } from '../web/src/utils/secretMask.ts';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

// ---- 1. 常见前缀令牌:保留前 8 个字符,其余打码 ----
{
  const sk = 'sk-proj-AbCdEf1234567890XyZ';
  const segs = splitSecrets(`我的 key 是 ${sk} 别外传`);
  const secret = segs.find((s) => s.t === 'secret');
  check('sk- 被识别', !!secret && secret.kind === 'token');
  check('保留前 8 位', !!secret && secret.v.startsWith('sk-proj-'));
  check('其余打码', !!secret && /\*/.test(secret.v) && !secret.v.includes('AbCdEf1234567890XyZ'));
  check('原文留存在 raw(复制/发送用原文)', !!secret && secret.raw === sk);
  check('前后普通文本原样', segs.filter((s) => s.t === 'text').map((s) => s.v).join('') === '我的 key 是  别外传');
}

// ---- 2. 各家令牌前缀都能认 ----
{
  const cases = {
    AIza: 'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    ghp: 'ghp_0123456789abcdefghijklmnopqrstuvwx',
    gitpat: 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789ABCDEF',
    glpat: 'glpat-abcdefghij1234567890',
    npm: 'npm_0123456789abcdefghijklmnopqrstuv',
    hf: 'hf_0123456789abcdefghijklmnopqrstuv',
    AKIA: 'AKIAIOSFODNN7EXAMPLE',
    xoxb: 'xoxb-1234567890-abcdefghij',
    stripe: 'sk_live_abcdefghijklmnop1234',
    whsec: 'whsec_abcdefghijklmnopqrstuvwx'
  };
  for (const [name, token] of Object.entries(cases)) {
    check(`${name} 令牌被遮挡`, hasSecret(`凭证 ${token} 结束`), token);
  }
}

// ---- 3. JWT:三段结构 ----
{
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const secret = splitSecrets(jwt).find((s) => s.t === 'secret');
  check('JWT 被识别且类型正确', !!secret && secret.kind === 'jwt');
  check('JWT 保留 eyJ 前缀', !!secret && secret.v.startsWith('eyJhbGci'));
}

// ---- 4. PEM 私钥块:保留 BEGIN/END 行,正文整体收起 ----
{
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabcdef123456\n-----END RSA PRIVATE KEY-----';
  const secret = splitSecrets(pem).find((s) => s.t === 'secret');
  check('私钥块被识别', !!secret && secret.kind === 'keyblock');
  check('保留 BEGIN 行', !!secret && secret.v.startsWith('-----BEGIN RSA PRIVATE KEY-----'));
  check('保留 END 行', !!secret && secret.v.trimEnd().endsWith('-----END RSA PRIVATE KEY-----'));
  check('正文不出现', !!secret && !secret.v.includes('MIIEowIBAAKCAQEA'));
  check('标明隐藏行数', !!secret && secret.v.includes('私钥正文已隐藏 2 行'));
}

// ---- 5. URL 里的密码:只遮密码 ----
{
  const url = 'postgres://admin:s3cretPassw0rd@db.internal:5432/app';
  const secret = splitSecrets(url).find((s) => s.t === 'secret');
  check('URL 密码被识别', !!secret && secret.kind === 'urlpass');
  check('用户名与主机保留', !!secret && secret.v.startsWith('postgres://admin:') && secret.v.endsWith('@'));
  check('密码不出现', !!secret && !secret.v.includes('s3cretPassw0rd'));
}

// ---- 6. 不该误伤:普通词、变量名、具名赋值、短片段 ----
{
  const safe = [
    '学习 sk-learn 的用法',                      // sk- 后无数字 → 不是密钥
    'sk-short',                                  // 太短
    'const apiKey = process.env.API_KEY',        // 具名赋值刻意不遮
    'token 用量 1234',                            // 普通文本
    'https://example.com/path?a=1',              // 无密码的 URL
    'AKIA'                                        // 前缀但长度不足
  ];
  for (const s of safe) check(`不误伤:${s.slice(0, 24)}`, !hasSecret(s), s);
}

// ---- 7. 一条消息里多个凭据:各段独立 ----
{
  const text = 'sk-proj-AAAAAAAA111111111111 和 ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2222';
  const secrets = splitSecrets(text).filter((s) => s.t === 'secret');
  check('识别出两个凭据', secrets.length === 2);
  check('两个都被打码', secrets.every((s) => /\*/.test(s.v)));
}

// ---- 8. maskSecretsToText 拼回来的文本:长度合理、无原文泄漏 ----
{
  const text = 'deploy 用完把 sk-proj-ZZZZZZZZZZZZ99999999 删掉';
  const masked = maskSecretsToText(text);
  check('拼回文本不含原文', !masked.includes('ZZZZZZZZZZZZ99999999'), masked);
  check('拼回文本保留前后文', masked.startsWith('deploy 用完把 ') && masked.endsWith(' 删掉'));
  check('空文本安全', maskSecretsToText('') === '' && splitSecrets('').length === 0);
}

console.log(`\n结果:${pass} 通过,${fail} 失败`);
if (fail > 0) process.exitCode = 1;
