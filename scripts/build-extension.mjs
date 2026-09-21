// Teleforge Auto 扩展打包:把 extension/ 打成可直接分发的 zip(GitHub Release 附件 / 桌面端资源同源)。
//
// 为什么自己写 ZIP 而不是调外部命令:
//   - 项目里没有 zip 依赖,而 Windows PowerShell 的 Compress-Archive 会写入反斜杠路径分隔符,
//     在 Linux/macOS 上解压出来会是一个名字里带反斜杠的怪文件;
//   - 纯 Node + zlib 写标准 ZIP(deflate、正斜杠、UTF-8 文件名)在三个平台产出一致。
//
// 用法:
//   node scripts/build-extension.mjs                 # 产出 output/teleforge-auto-v<版本>.zip
//   node scripts/build-extension.mjs --out=foo.zip   # 指定输出路径
//   node scripts/build-extension.mjs --list          # 只列出会打进去的文件
// CI 在 extension-v* tag 上会校验 tag 与 manifest.version 一致(与桌面端 check-versions 同一思路)。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXT_DIR = path.join(root, 'extension');
export const OUT_DIR = path.join(root, 'output');

/** 扩展必须带的文件:缺一个装进浏览器就会报错 */
const REQUIRED = ['manifest.json', 'background.js', 'cdp.js', 'page-ops.js', 'popup.html', 'popup.js'];

// ---------------- 最小 ZIP 写入 ----------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** JS Date → MS-DOS 时间/日期字(1980 年起的 16 位对) */
function dosStamp(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

/**
 * 写一个标准 ZIP。
 * @param {Array<{name: string, data?: Buffer, mtime: Date, dir: boolean}>} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = e.dir ? Buffer.alloc(0) : e.data;
    const method = e.dir ? 0 : 8; // 0=store(目录), 8=deflate
    const body = e.dir ? Buffer.alloc(0) : zlib.deflateRawSync(raw, { level: 9 });
    const crc = e.dir ? 0 : crc32(raw);
    const { time, date } = dosStamp(e.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // 本地文件头签名
    local.writeUInt16LE(20, 4);           // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6);       // 通用标志:文件名为 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // 扩展字段长度
    parts.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);      // 中央目录头签名
    cd.writeUInt16LE(0x031e, 4);          // 制作版本:UNIX + 3.0(带外部属性)
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);              // 扩展字段
    cd.writeUInt16LE(0, 32);              // 注释
    cd.writeUInt16LE(0, 34);              // 起始磁盘
    cd.writeUInt16LE(0, 36);              // 内部属性
    cd.writeUInt32LE(e.dir ? ((0o755 << 16) | 0x10) : (0o644 << 16), 38); // 外部属性:权限位
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);      // 中央目录结束记录
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

// ---------------- 收集与打包 ----------------

/** 递归收集扩展目录(目录项也写进去,兼容不自动建目录的解压工具) */
async function collect(dir, prefix = '') {
  const out = [];
  const entries = (await fsp.readdir(dir, { withFileTypes: true }))
    .filter((e) => e.name !== '.DS_Store')
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out.push({ name: rel + '/', dir: true, mtime: (await fsp.stat(abs)).mtime });
      out.push(...(await collect(abs, rel)));
    } else if (ent.isFile()) {
      const st = await fsp.stat(abs);
      out.push({ name: rel, data: await fsp.readFile(abs), mtime: st.mtime, dir: false });
    }
  }
  return out;
}

/** 读 manifest 里的名字与版本(版本号唯一来源) */
export function readManifest() {
  const file = path.join(EXT_DIR, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!m.version) throw new Error('extension/manifest.json 缺少 version');
  return m;
}

/** 校验 tag 与 manifest.version 一致(CI 上防止「发了 extension-v1.1.0 却没改版本号」) */
function checkTag(version) {
  const ref = process.env.GITHUB_REF_NAME || '';
  if (/^extension-v/.test(ref) && ref !== `extension-v${version}`) {
    throw new Error(`发布 tag ${ref} 与 extension/manifest.json 的版本 ${version} 不一致(应打 extension-v${version})`);
  }
}

export async function buildExtensionZip({ out, quiet = false } = {}) {
  const manifest = readManifest();
  checkTag(manifest.version);

  for (const name of REQUIRED) {
    if (!fs.existsSync(path.join(EXT_DIR, name))) throw new Error(`extension/${name} 缺失,无法打包`);
  }

  const entries = await collect(EXT_DIR);
  const zip = buildZip(entries);

  const outFile = out
    ? path.resolve(root, out)
    : path.join(OUT_DIR, `teleforge-auto-v${manifest.version}.zip`);
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  await fsp.writeFile(outFile, zip);

  const sha = crypto.createHash('sha256').update(zip).digest('hex');
  if (!quiet) {
    for (const e of entries) {
      if (e.dir) continue;
      console.log(`   ${e.name.padEnd(18)} ${String(e.data.length).padStart(7)} B`);
    }
  }
  return { file: outFile, bytes: zip.length, sha256: sha, version: manifest.version, name: manifest.name, files: entries.filter((e) => !e.dir).length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  try {
    console.log('== Teleforge Auto 扩展打包 ==');
    if (process.argv.includes('--list')) {
      const entries = await collect(EXT_DIR);
      for (const e of entries) console.log(`   ${e.name}${e.dir ? '' : `  ${e.data.length} B`}`);
      process.exit(0);
    }
    const r = await buildExtensionZip({ out: outArg ? outArg.slice('--out='.length) : undefined });
    console.log(`\n${r.name} v${r.version} · ${r.files} 个文件 · ${(r.bytes / 1024).toFixed(1)} KB`);
    console.log(`输出:${r.file}`);
    console.log(`sha256:${r.sha256}`);
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exit(1);
  }
}
