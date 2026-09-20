// 版本号一致性校验:三处版本号必须相同,否则会出现「装到最新版仍提示有新版本」。
//
//   package.json            → 前端展示(vite define 注入 __APP_VERSION__)
//   src-tauri/Cargo.toml    → 自动更新比较(env!("CARGO_PKG_VERSION"),update_info 的 current)
//   src-tauri/tauri.conf.json → 安装包在系统里登记的版本
//
// 历史教训:v0.2.4 只改了 package.json,Cargo.toml 仍是 0.2.3,于是 update_info 里
// current=0.2.3 < latest=0.2.4,has_update 恒为 true——用户装完 0.2.4 后顶栏一直提示更新 0.2.4。
//
// 用法:
//   node scripts/check-versions.mjs          # 校验,不一致退出码 1
//   node scripts/check-versions.mjs --fix    # 以 package.json 为准自动改写另两处
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PKG_FILE = path.join(root, 'package.json');
export const CARGO_FILE = path.join(root, 'src-tauri', 'Cargo.toml');
export const CONF_FILE = path.join(root, 'src-tauri', 'tauri.conf.json');

/** 只取 [package] 段的 version,避免误抓依赖里的 version */
export function cargoPackageVersion(text) {
  let inPackage = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('[')) {
      inPackage = t === '[package]';
      continue;
    }
    if (!inPackage) continue;
    const m = t.match(/^version\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return null;
}

/** 重写 [package] 段的 version,其余内容逐字保留 */
function rewriteCargoVersion(text, version) {
  const lines = text.split(/\r?\n/);
  let inPackage = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('[')) {
      inPackage = t === '[package]';
      continue;
    }
    if (inPackage && /^version\s*=\s*"/.test(t)) {
      lines[i] = `version = "${version}"`;
      return lines.join('\n');
    }
  }
  throw new Error('Cargo.toml 中未找到 [package] 段的 version');
}

/** 读取三处版本号 */
export function readVersions() {
  return {
    pkg: JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')).version,
    cargo: cargoPackageVersion(fs.readFileSync(CARGO_FILE, 'utf8')),
    conf: JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')).version
  };
}

/**
 * 校验三处一致(并以 package.json 为准同步)。
 * 另在 CI 打 tag 时校验 tag 与版本号一致,防止「发了 v0.2.5 却没改版本号」。
 * @param {{fix?: boolean, quiet?: boolean}} [opts]
 */
export function checkVersions(opts = {}) {
  const { fix = false, quiet = false } = opts;
  const v = readVersions();

  if (fix) {
    if (!v.pkg) throw new Error('package.json 缺少 version');
    if (v.cargo !== v.pkg) {
      fs.writeFileSync(CARGO_FILE, rewriteCargoVersion(fs.readFileSync(CARGO_FILE, 'utf8'), v.pkg));
      v.cargo = v.pkg;
    }
    if (v.conf !== v.pkg) {
      const conf = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
      conf.version = v.pkg;
      fs.writeFileSync(CONF_FILE, JSON.stringify(conf, null, 2) + '\n');
      v.conf = v.pkg;
    }
  }

  const rows = [
    ['package.json', v.pkg],
    ['src-tauri/Cargo.toml', v.cargo],
    ['src-tauri/tauri.conf.json', v.conf]
  ];
  if (!quiet) {
    for (const [file, ver] of rows) {
      console.log(`   ${file.padEnd(26)} ${ver ?? '(未找到)'}${ver === v.pkg ? '' : '  ← 与 package.json 不一致'}`);
    }
  }

  const mismatched = rows.filter(([, ver]) => ver !== v.pkg);
  if (mismatched.length) {
    throw new Error(
      `版本号不一致(package.json = ${v.pkg},${mismatched.map(([f, x]) => `${f} = ${x}`).join(',')})。` +
      '请运行 node scripts/check-versions.mjs --fix 同步。'
    );
  }

  // tag 触发构建时必须 tag == v<version>,否则会把版本号错的包发出去
  const ref = process.env.GITHUB_REF_NAME || '';
  if (/^v\d/.test(ref) && ref !== `v${v.pkg}`) {
    throw new Error(`发布 tag ${ref} 与 package.json 版本 ${v.pkg} 不一致(应打 v${v.pkg})`);
  }

  return v;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const fix = process.argv.includes('--fix');
  try {
    console.log('== 版本号一致性 ==');
    const v = checkVersions({ fix });
    console.log(fix ? `已同步为 ${v.pkg} ✓` : `三处一致:${v.pkg} ✓`);
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exit(1);
  }
}
