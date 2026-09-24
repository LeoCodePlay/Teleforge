// 多 API Key 轮询的持久化层测试:Key 归一化 / 可用 Key 过滤 / 无余额标记与重置。
// 这一层决定「服务端轮询时到底会拿哪些 Key」,所以断言必须落到实际返回值上:
//   - 被标记无余额的 Key 必须从 usableKeys 里消失(未重置前不会被再次尝试);
//   - 点「重置」后必须重新出现(充值后能再次尝试);
//   - apiKeys 是权威列表,apiKey 永远镜像首项(旧单 Key 路径也要能用)。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-keys-'));

const { aiProviders, normalizeKeys, usableKeys } = await import('../server/store/ai-providers-store.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

console.log('== Key 归一化 ==');
{
  check('去空白 + 去重,主 Key 在首位',
    JSON.stringify(normalizeKeys(' a ', ['b', 'a', ' b ', '', '  '])) === '["a","b"]',
    JSON.stringify(normalizeKeys(' a ', ['b', 'a', ' b ', '', '  '])));
  check('只给主 Key 时返回单元素列表', JSON.stringify(normalizeKeys('k', undefined)) === '["k"]');
  check('全空时返回空列表', JSON.stringify(normalizeKeys('', [])) === '[]');
  check('apiKeys 里的主 Key 不会重复出现',
    JSON.stringify(normalizeKeys('k', ['k', 'k2'])) === '["k","k2"]',
    JSON.stringify(normalizeKeys('k', ['k', 'k2'])));
}

console.log('\n== 入库对齐(apiKeys 权威、apiKey 镜像首项)==');
{
  const p = aiProviders.add({ id: 'p1', name: 'P1', baseUrl: 'https://x/v1', apiKey: 'k1', apiKeys: ['k1', 'k2', 'k3'], models: ['m'], note: '' });
  check('apiKey 镜像 apiKeys[0]', p.apiKey === 'k1' && p.apiKeys?.[0] === 'k1', JSON.stringify([p.apiKey, p.apiKeys]));
  check('三个 Key 都在列表里', JSON.stringify(p.apiKeys) === '["k1","k2","k3"]', JSON.stringify(p.apiKeys));

  // 只给 apiKey 不给 apiKeys = 旧单 Key 编辑路径:语义是「单 Key 覆盖」
  aiProviders.update('p1', { apiKey: 'solo' });
  const after = aiProviders.find('p1');
  check('只给 apiKey 时降级为单 Key 覆盖',
    after?.apiKey === 'solo' && JSON.stringify(after?.apiKeys) === '["solo"]',
    JSON.stringify([after?.apiKey, after?.apiKeys]));

  // 给 apiKeys(权威):apiKey 跟着变
  aiProviders.update('p1', { apiKeys: ['a', 'b'] });
  const after2 = aiProviders.find('p1');
  check('给 apiKeys 时 apiKey 跟随首项',
    after2?.apiKey === 'a' && JSON.stringify(after2?.apiKeys) === '["a","b"]',
    JSON.stringify([after2?.apiKey, after2?.apiKeys]));
}

console.log('\n== 无余额标记 -> 轮询跳过 -> 重置恢复 ==');
{
  const p = aiProviders.find('p1');
  check('初始时两个 Key 都可用', JSON.stringify(usableKeys(p)) === '["a","b"]', JSON.stringify(usableKeys(p)));

  check('标记成功', aiProviders.markKeyExhausted('p1', 'a', 'HTTP 402 余额不足') === true);
  const marked = aiProviders.find('p1');
  check('被标记的 Key 从可用列表消失', JSON.stringify(usableKeys(marked)) === '["b"]', JSON.stringify(usableKeys(marked)));
  check('状态里留下了原因与时间',
    marked.keyStates?.a?.exhausted === true && /余额不足/.test(String(marked.keyStates?.a?.reason)) && typeof marked.keyStates?.a?.at === 'number',
    JSON.stringify(marked.keyStates?.a));

  // 第二个 Key 也被判定无余额:可用列表为空 —— 上层据此停止重试
  aiProviders.markKeyExhausted('p1', 'b', 'HTTP 402');
  check('全部 Key 都被标记后可用列表为空', usableKeys(aiProviders.find('p1')).length === 0, JSON.stringify(usableKeys(aiProviders.find('p1'))));

  // 重置单个 Key(充值后点「重置」)
  check('重置单个 Key 成功', aiProviders.resetKey('p1', 'a') === true);
  const reset = aiProviders.find('p1');
  check('重置后的 Key 重新可用,另一个仍被跳过',
    JSON.stringify(usableKeys(reset)) === '["a"]',
    JSON.stringify(usableKeys(reset)));

  // 重置全部
  aiProviders.markKeyExhausted('p1', 'a', 'HTTP 402');
  aiProviders.resetAllKeys('p1');
  const all = aiProviders.find('p1');
  check('全部重置后两个 Key 都可用', JSON.stringify(usableKeys(all)) === '["a","b"]', JSON.stringify(usableKeys(all)));
  check('全部重置后状态表为空', Object.keys(all.keyStates || {}).length === 0, JSON.stringify(all.keyStates));
}

console.log('\n== 边界 ==');
{
  check('标记不存在的提供商返回 false', aiProviders.markKeyExhausted('nope', 'a', 'x') === false);
  check('空 Key 不标记(避免污染状态表)', aiProviders.markKeyExhausted('p1', '   ', 'x') === false);
  check('重置不存在的 Key 不报错', aiProviders.resetKey('p1', 'ghost') === true);
  check('不存在的提供商 resetKey 返回 false', aiProviders.resetKey('nope', 'a') === false);
  check('不存在的提供商 resetAllKeys 返回 false', aiProviders.resetAllKeys('nope') === false);

  // 从列表里删掉一个 Key:它残留的「无余额」状态必须一起清掉,避免以后重新加回来时"复活"
  aiProviders.markKeyExhausted('p1', 'b', 'HTTP 402');
  check('删除前 b 被标记', aiProviders.find('p1').keyStates?.b?.exhausted === true);
  aiProviders.update('p1', { apiKeys: ['a'] });
  const cleaned = aiProviders.find('p1');
  check('删除 Key 后残留状态被清理', cleaned.keyStates?.b === undefined, JSON.stringify(cleaned.keyStates));
  check('删除后可用列表只剩 a', JSON.stringify(usableKeys(cleaned)) === '["a"]', JSON.stringify(usableKeys(cleaned)));

  // 删掉提供商本身
  check('删除提供商成功', aiProviders.remove('p1') === true);
  check('删除后查不到', aiProviders.find('p1') === undefined);
}

console.log(`\nai-providers-multikey: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);