import { execLocal } from '../server/local-exec.js';
let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

const out = await execLocal('echo local-exec-ok', { cwd: process.cwd() });
check('execLocal 执行成功退出码 0', out.code === 0 && out.stdout.trim() === 'local-exec-ok', JSON.stringify(out));

const err = await execLocal('node -e "console.error(\'boom\');process.exit(3)"');
check('execLocal 非零退出码透传', err.code === 3 && err.stderr.includes('boom'), JSON.stringify(err));

const noOut = await execLocal('echo x && echo y && echo z');
check('execLocal 多行输出合并到 stdout', noOut.stdout.split('\n').filter(Boolean).length === 3);

const t0 = Date.now();
const timed = await execLocal('node -e "setTimeout(()=>{},5000)"', { timeout: 500 });
check('execLocal 超时终止', timed.timedOut === true && (Date.now() - t0) < 4000, JSON.stringify(timed));

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);