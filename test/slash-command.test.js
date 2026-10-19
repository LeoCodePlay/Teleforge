// matchSlashCommand 单测:决定「哪些输入算命令、必须被前端拦截执行」。
// 回归背景:/compact 过去只有「/ 菜单打开并高亮选中」这一条执行路径,手打回车
// （菜单已关、末尾多打空格、带参数、手机按钮发送）都会把 "/compact" 当普通消息
// 发给模型,表现为「假压缩」:前端有画面、服务端无 compaction/done 落盘,切会话即消失。
import { matchSlashCommand, insertSlashToken } from '../web/src/utils/slashCommand.ts';

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

// 中文 token:teleforge 是中文产品,harness 的 zh 词条把 /plan 显示为「计划」、/goal 显示为「目标」,
// 用户按中文输入必须与规范名等价命中(见 harness 的 command-menu-zh 用例)
const ZH = [...NAMES, '计划', 'plan', '目标', 'goal'];
check('中文 token /计划 命中(返回 token 由调用方映射回命令)',
  JSON.stringify(matchSlashCommand('/计划', ZH)) === JSON.stringify({ name: '计划', args: '' }),
  JSON.stringify(matchSlashCommand('/计划', ZH)));
check('中文 token 带参数', matchSlashCommand('/目标 把两个命令补齐', ZH)?.args === '把两个命令补齐');
check('中文 token 带空格', matchSlashCommand('/ 计划 off', ZH)?.name === '计划'
  && matchSlashCommand('/ 计划 off', ZH)?.args === 'off');
check('规范名仍然命中 /plan off', matchSlashCommand('/plan off', ZH)?.name === 'plan'
  && matchSlashCommand('/plan off', ZH)?.args === 'off');
miss('/计划中', '中文 token 必须完整成词');
miss('/计划之外的事情', '中文 token 后必须紧跟空白');

// 菜单选中命令 = 只补全命令词(不执行):插入结果必须仍是一条"待发送"的斜杠命令文本,
// 且第一次回车执行的是**裸命令**、补参数后回车执行的是**带参数命令**(harness 的 claim 语义)。
// 回归背景:过去 pickSlash 直接 item.run(query) 并清空输入框,菜单里点一下就把命令用空参数
// 执行掉了 —— /目标 因此只创建出 "goal"、"gl" 这种空目标,用户没有任何写参数的机会。
{
  const ins = (s, name, token) => insertSlashToken(s, name, token);
  const t1 = ins('/目标', 'goal', '目标');
  check('补全 /目标 → /目标 +尾随空格,光标停在参数位',
    t1.text === '/目标 ' && t1.caret === 4, JSON.stringify(t1));
  check('补全结果仍是可发送的裸命令', (() => {
    const r = matchSlashCommand(t1.text, ZH);
    return !!r && r.name === '目标' && r.args === '';
  })(), JSON.stringify(matchSlashCommand(t1.text, ZH)));

  const t2 = ins('/go', 'goal');
  check('规范名补全 /go → /goal ', t2.text === '/goal ' && t2.caret === 6, JSON.stringify(t2));

  const t3 = ins('先看下仓库 /计划', 'plan', '计划');
  check('保留 / 之前的文本,只替换末尾那个词', t3.text === '先看下仓库 /计划 ' && t3.caret === 10, JSON.stringify(t3));

  const t4 = ins('/目标 ', 'goal', '目标');
  check('命令词已完整存在时不重复插入', t4.text === '/目标 ' && t4.caret === 4, JSON.stringify(t4));

  const t5 = ins('/目标 查一下广西天气', 'goal', '目标');
  check('已带参数的输入原样保留', t5.text === '/目标 查一下广西天气' && t5.caret === t5.text.length, JSON.stringify(t5));

  const t6 = ins('普通文本没有斜杠词', 'goal', '目标');
  check('没有末尾 /词时原样返回', t6.text === '普通文本没有斜杠词' && t6.caret === 9, JSON.stringify(t6));

  check('补全后补参数再送 = 带参数命令', (() => {
    const r = matchSlashCommand(t1.text + '查一下广西天气', ZH);
    return !!r && r.name === '目标' && r.args === '查一下广西天气';
  })(), JSON.stringify(matchSlashCommand(t1.text + '查一下广西天气', ZH)));
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
