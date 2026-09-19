// 首条提问悬停提示测试:会话刚创建(事件日志为空)时不得把空结果缓存住。
// 否则用户发出首条消息后,侧栏悬停提示会一直是 24 字标题(看起来"只有一行"),
// 直到服务端重启为止。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-tip-'));
const sessions = await import('../server/store/session-store.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };
const userMsg = (text, extra = {}) => ({ type: 'user/message', data: { source: 'user', display: text, content: text, ...extra } });

// 1) 新会话:首条提问还没落盘,首次调用返回空,且这个空结果不能进缓存
const a = sessions.create('新会话', 'local');
check('空会话 firstPrompt 为空', sessions.firstPrompt(a.id) === '');

// 2) 首条用户消息落盘后,悬停提示必须立刻能看到完整提问
sessions.saveEvents(a.id, [userMsg('帮我规划并实现一个介绍这个项目的网站')]);
const tip = sessions.firstPrompt(a.id);
check('首条消息落盘后返回提问(不被空缓存粘住)', tip === '帮我规划并实现一个介绍这个项目的网站', tip);

// 3) 超过 300 字截断为 300 字 + 省略号
const b = sessions.create('长提问', 'local');
sessions.firstPrompt(b.id); // 先经历"日志还空"的时机,再落盘
sessions.saveEvents(b.id, [userMsg('长'.repeat(400))]);
const longTip = sessions.firstPrompt(b.id);
check('超长提问截断到 300 字 + 省略号', longTip.length === 301 && longTip.endsWith('…'), `len=${longTip.length}`);

// 4) display 缺失时回退 content(/技能 注入会话 display 为空,content 才是用户原文)
const c = sessions.create('技能注入', 'local');
sessions.saveEvents(c.id, [{ type: 'user/message', data: { source: 'user', display: '', content: '真正的用户提问' } }]);
check('display 为空时回退 content', sessions.firstPrompt(c.id) === '真正的用户提问', sessions.firstPrompt(c.id));

// 5) 回退删掉首条提问(内容消息数变化)后,缓存失效并返回新的首条提问
sessions.saveEvents(c.id, [userMsg('回退后新的首条提问')]);
check('首条提问变化后缓存失效', sessions.firstPrompt(c.id) === '回退后新的首条提问', sessions.firstPrompt(c.id));

console.log(`\nfirst-prompt: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
