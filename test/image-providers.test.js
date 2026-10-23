// 「生图模型商」store 单测:
// 覆盖旧版单条 imageTool 的一次性迁移、多条目增删改/使用中切换、多 Key 轮询状态与重置。
// 需临时 DATA_DIR 隔离:先写一份旧版 settings.json,再首次加载 store,验证迁移链路。
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-imgprov-'));
const DATA_DIR = process.env.DATA_DIR;

// 旧版本只有 settings.json 里的一条 imageTool:先把它准备好,store 的首次加载会据此迁移
writeFileSync(join(DATA_DIR, 'settings.json'), JSON.stringify({
  version: 1,
  defaultPermissionMode: 'confirm',
  imageTool: {
    baseUrl: 'https://legacy.example.com/v1/',
    apiKey: 'sk-legacy',
    model: 'legacy-image-1',
    quality: 'high',
    size: '1536x1024',
    dialect: 'image_single'
  }
}));

const { imageProviders, imageKeys, usableImageKeys } = await import('../server/store/image-providers-store.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

function main() {
  // ---------- 1. 旧配置迁移 ----------
  console.log('\n[1] 旧版单条生图配置迁移');
  const migrated = imageProviders.list();
  check('迁移为一条模型商', migrated.length === 1, JSON.stringify(migrated));
  check('Base URL 去掉尾斜杠并保留模型', migrated[0]?.baseUrl === 'https://legacy.example.com/v1' && migrated[0]?.model === 'legacy-image-1', JSON.stringify(migrated[0]));
  check('保留默认质量 / 尺寸 / 方言', migrated[0]?.quality === 'high' && migrated[0]?.size === '1536x1024' && migrated[0]?.dialect === 'image_single');
  check('单个 Key 迁移进多 Key 列表并镜像为主 Key', migrated[0]?.apiKey === 'sk-legacy' && imageKeys(migrated[0]).join(',') === 'sk-legacy');
  check('迁移条目自动成为使用中', imageProviders.activeId() === migrated[0]?.id && imageProviders.active()?.id === migrated[0]?.id);
  check('迁移结果写入独立配置文件', existsSync(join(DATA_DIR, 'image-providers.json')));

  // ---------- 2. 新增与校验 ----------
  console.log('\n[2] 新增与字段校验');
  const bad = (raw) => { try { imageProviders.add(raw); return false; } catch { return true; } };
  check('缺 Base URL / 模型名被拒', bad({ name: 'x' }));
  check('Base URL 缺协议被拒', bad({ name: 'x', baseUrl: 'img.example.com', model: 'm' }));
  const added = imageProviders.add({
    name: '备用网关',
    baseUrl: 'https://img.example.com/v1/',
    apiKey: 'sk-b',
    model: 'm-2',
    quality: 'bogus',
    size: '999x999',
    dialect: 'bogus'
  }, { activate: false });
  check('新增条目进入列表', imageProviders.list().some((p) => p.id === added.id));
  check('非法质量 / 尺寸 / 方言回落到 auto', added.quality === 'auto' && added.size === 'auto' && added.dialect === 'auto', JSON.stringify(added));
  check('activate=false 不抢走使用中', imageProviders.activeId() === migrated[0]?.id);

  // ---------- 3. 多 Key 轮询状态 ----------
  console.log('\n[3] 多 Key 轮询状态与重置');
  const multi = imageProviders.add({
    name: '多 Key 网关', baseUrl: 'https://img.example.com/v1',
    apiKey: 'sk-1', apiKeys: ['sk-1', 'sk-2', 'sk-1'], model: 'm-3'
  }, { activate: false });
  const found = imageProviders.find(multi.id);
  check('Key 去重且 apiKey 镜像首项', imageKeys(found).join(',') === 'sk-1,sk-2' && found.apiKey === 'sk-1', JSON.stringify(found));
  check('初始全部 Key 可用', usableImageKeys(found).join(',') === 'sk-1,sk-2');

  imageProviders.markKeyExhausted(multi.id, 'sk-1', 'quota exceeded', 'balance');
  const marked = imageProviders.find(multi.id);
  check('余额不足标记写入', marked.keyStates?.['sk-1']?.exhausted === true && marked.keyStates?.['sk-1']?.reason === 'quota exceeded', JSON.stringify(marked.keyStates));
  check('不可用 Key 被轮询过滤', usableImageKeys(marked).join(',') === 'sk-2');

  imageProviders.markKeyExhausted(multi.id, 'sk-2', 'invalid key', 'auth');
  check('鉴权失败单独记为 invalid', imageProviders.find(multi.id)?.keyStates?.['sk-2']?.invalid === true);

  imageProviders.resetKey(multi.id, 'sk-1');
  check('重置单个 Key 后恢复参与轮询', usableImageKeys(imageProviders.find(multi.id)).join(',') === 'sk-1');
  imageProviders.resetAllKeys(multi.id);
  check('重置全部后两个 Key 都可用', usableImageKeys(imageProviders.find(multi.id)).length === 2);

  imageProviders.markKeyExhausted(multi.id, 'sk-1', 'x', 'balance');
  imageProviders.update(multi.id, { apiKeys: ['sk-2'] });
  check('Key 从列表删除后其状态一并清除', !imageProviders.find(multi.id)?.keyStates, JSON.stringify(imageProviders.find(multi.id)?.keyStates));

  // ---------- 4. 使用中切换与删除回落 ----------
  console.log('\n[4] 使用中切换与删除回落');
  check('setActive 未知 id 返回 false', imageProviders.setActive('img_nope') === false);
  imageProviders.setActive(multi.id);
  check('切换使用中生效', imageProviders.activeId() === multi.id && imageProviders.active()?.id === multi.id);
  imageProviders.remove(multi.id);
  check('删除使用中的条目后自动回落到第一条', imageProviders.activeId() === imageProviders.list()[0].id);
  check('更新的模型名/地址持久化到条目', imageProviders.update(added.id, { model: 'm-9', baseUrl: 'https://img2.example.com/v1' })?.model === 'm-9');

  // ---------- 5. 删空后不重复迁移 ----------
  console.log('\n[5] 删空后的状态');
  for (const p of imageProviders.list()) imageProviders.remove(p.id);
  check('删空后 active=null 且列表为空', imageProviders.list().length === 0 && imageProviders.active() === null && imageProviders.activeId() === '');
  const saved = JSON.parse(readFileSync(join(DATA_DIR, 'image-providers.json'), 'utf8'));
  check('空列表已落盘(下次启动不会再把旧配置迁回来)', Array.isArray(saved.providers) && saved.providers.length === 0);

  console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
  if (fail > 0) process.exit(1);
}

main();
