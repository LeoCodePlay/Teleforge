// 本地路径打开(local_reveal)入参校验测试:
// 空路径 / 不存在的目录必须在调起文件管理器之前就报错,避免给 explorer.exe 传垃圾参数。
// 只覆盖校验分支——成功分支会真的弹出系统资源管理器窗口,不适合放进测试套件。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-reveal-'));
const { registerLocal } = await import('../server/api/rpc/local.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

const handlers = new Map();
registerLocal({ register: (t, h) => handlers.set(t, h), types: () => [...handlers.keys()] });
check('local_reveal 已注册', handlers.has('local_reveal'));
const call = (msg) => handlers.get('local_reveal')(msg, { reply() {} });

let err = '';
try { await call({ path: '   ' }); } catch (e) { err = e.message; }
check('空路径报「缺少路径」', err === '缺少路径', err);

err = '';
try { await call({}); } catch (e) { err = e.message; }
check('缺 path 字段报「缺少路径」', err === '缺少路径', err);

err = '';
const missing = path.join(tmpdir(), `sshai-not-exist-${Date.now()}`);
try { await call({ path: missing }); } catch (e) { err = e.message; }
check('目录不存在时先报错(不调起文件管理器)', /目录不存在/.test(err), err);

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
