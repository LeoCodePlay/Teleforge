// 一次性检查:CSS module 声明是否存在、几个关键文件在不在、适配层导出了什么。
const fs = require('fs');

const decls = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const q = d + '/' + e.name;
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dsh') walk(q); continue; }
    if (!/\.d\.ts$/.test(e.name)) continue;
    const t = fs.readFileSync(q, 'utf8');
    const lines = t.split(/\r?\n/).filter((l) => /declare module/.test(l));
    if (lines.length) decls.push(q + ' :: ' + lines.join(' | '));
  }
})('web/src');
console.log('--- ambient module declarations in web/src (excluding dsh) ---');
console.log(decls.join('\n') || 'NONE');

const files = [
  'web/src/dsh/ui-primitives/css-modules.d.ts',
  'web/src/dsh/ui-deliverables/types.ts',
  'web/src/dsh/ui-deliverables/client/locales.ts',
  'web/src/dsh/ui-deliverables/client/review-store.ts',
  'web/src/dsh/ui-sidebar-documentpreview/client/code/locales.ts',
  'web/src/dsh/ui-sidebar-documentpreview/client/TextPreview.module.css',
  'web/src/dsh/ui-sidebar-documentpreview/client/code/CodeBody.module.css',
  'web/src/dsh/ui-sidebar-documentpreview/client/document/registry.ts',
  'web/src/dsh-adapters/sidebar-right-types/index.ts',
];
console.log('--- existence ---');
for (const f of files) console.log(fs.existsSync(f) ? 'EXISTS ' + f : 'MISSING ' + f);

console.log('--- sidebar-right-types adapter exports ---');
console.log(fs.readFileSync('web/src/dsh-adapters/sidebar-right-types/index.ts', 'utf8'));
