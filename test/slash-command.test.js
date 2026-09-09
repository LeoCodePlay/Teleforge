// matchSlashCommand 单测:决定「哪些输入算命令、必须被前端拦截执行」。
// 回归背景:/compact 过去只有「/ 菜单打开并高亮选中」这一条执行路径,手打回车
// （菜单已关、末尾多打空格、带参数、手机按钮发送）都会把 "/compact" 当普通消息
// 发给模型,表现为「假压缩」:前端有画面、服务端无 compaction/done 落盘,切会话即消失。
import { matchSlashCommand } from '../web/src/utils/slashCommand.ts';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

const NAMES = ['compact', 'clear', 'fork', 'help'];
const hit = (text, name, args) => {
  const r = matchSlashCommand(text, NAMES);
  check(`命中 ${JSON.stringify(text)}`, !!r && r.name === name && r.args === args, `got ${JSON.stringify(r)}`);
};
const miss = (text, why) => {
  check(`不当命令 ${JSON.stringify(text)}(${why})`, matchSlashCommand(text, NAMES) === null,
    `got ${JSON.stringify(matchSlashCommand(text, NAMES))}`);
};

// 必须命中:命令词的各种书写变体
hit('/compact', 'compact', '');
hit('/compact ', 'compact', '');        // 菜单选中技能后的书写习惯带尾随空格,过去正是这条漏掉了
hit('  /compact', 'compact', '');
hit('/COMPACT', 'compact', '');
hit('/ COMPACT', 'compact', '');
hit('/compact 摘要请重点保留文件变更', 'compact', '摘要请重点保留文件变更');
hit('/compact   多  空格  参数 ', 'compact', '多  空格  参数');
hit('/compact\n换行后的参数', 'compact', '换行后的参数');
hit('/clear', 'clear', '');
hit('/fork', 'fork', '');

// 必须不命中:普通消息、技能、路径、句中的斜杠词
miss('你好 /compact', '命令不在首词');
miss('帮我 /compact 一下', '命令在句中');
miss('/unknownthing', '未注册命令名');
miss('/some-skill 做点事', '技能仍交给后端解析注入');
miss('/usr/bin/node -v', '路径不是命令');
miss('/compactextra', '命令词必须完整成词');
miss('@file.ts 看看这个', '@引用与命令无关');
miss('', '空输入');
miss('   ', '纯空白');
miss(null, 'null 输入不抛错');

// 命令表大小写与新增项自适应(命令表若加了新名字,解析器无需改动)
hit('/Compact x', 'compact', 'x');
check('命令表未含的名字不命中', matchSlashCommand('/deploy', NAMES) === null);
check('命令表扩项即生效', matchSlashCommand('/deploy prod', ['deploy']).args === 'prod');

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
