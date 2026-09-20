// 会话列表状态点优先级(纯函数,无 DOM 依赖)
// 绿:任务进行中 > 黄:等待用户操作 > 蓝:会话空闲但有后台终端在跑 > 不显示
import { sessionDot, sessionDotClass, SESSION_DOT_TIP } from '../web/src/utils/sessionDot.ts';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

console.log('\n[会话列表状态点]');
check('任务进行中 → 绿', sessionDot({ running: true, askWaiting: false, termRunning: false }) === 'run');
check('进行中优先于等待提问 → 绿', sessionDot({ running: true, askWaiting: true, termRunning: true }) === 'run');
check('等待用户操作 → 黄', sessionDot({ running: false, askWaiting: true, termRunning: false }) === 'warn');
check('等待提问优先于后台终端 → 黄', sessionDot({ running: false, askWaiting: true, termRunning: true }) === 'warn');
check('空闲但有后台终端在跑 → 蓝', sessionDot({ running: false, askWaiting: false, termRunning: true }) === 'term');
check('三样都没有 → 不显示', sessionDot({ running: false, askWaiting: false, termRunning: false }) === 'idle');

console.log('\n[class 与提示文案]');
check('绿点用基础类(不加修饰类)', sessionDotClass('run') === 's-run', sessionDotClass('run'));
check('黄点带 warn', sessionDotClass('warn') === 's-run warn', sessionDotClass('warn'));
check('蓝点带 term', sessionDotClass('term') === 's-run term', sessionDotClass('term'));
check('空闲带 idle(占位不显示)', sessionDotClass('idle') === 's-run idle', sessionDotClass('idle'));
check('四种状态都有对应的提示文案(空闲为 null)', SESSION_DOT_TIP.run === '任务进行中'
  && SESSION_DOT_TIP.warn === '等待用户操作' && SESSION_DOT_TIP.term === '有后台终端在运行'
  && SESSION_DOT_TIP.idle === null);

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
