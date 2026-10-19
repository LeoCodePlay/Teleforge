// 对话字号 + 每模型推理等级的纯逻辑单测(上游 dsh 0.2.1-rc:8096e18504 字号快捷键 / f61d9982f8 档位可编辑)。
// 这两个模块都只在函数体里碰 DOM / localStorage,所以这里给两个最小桩即可在 Node 下跑,
// 不必引入 jsdom —— 我们验证的是"档位换算、范围钳制、持久化格式、支持的档位筛选"这些规则。
const styleStore = {};
globalThis.document = {
  documentElement: { style: { setProperty: (k, v) => { styleStore[k] = v; }, getPropertyValue: (k) => styleStore[k] ?? '' } },
  addEventListener: () => {},
  removeEventListener: () => {}
};
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};

const {
  CHAT_FONT_SIZES, CHAT_FONT_DEFAULT, applyChatFont, stepChatFont, readChatFont, currentChatFont
} = await import('../web/src/utils/chatFont.ts');
const { REASONING_LEVELS, supportedLevels, isReasoningLevelId, levelsSummary, modelSupportedLevels } =
  await import('../web/src/utils/reasoningLevels.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

// ---- 1. 字号:默认值、写入 CSS 变量、持久化 ----
{
  check('默认档位是 14(与现有样式基准一致)', CHAT_FONT_DEFAULT === 14);
  check('未写过 localStorage 时读默认', readChatFont() === 14);
  applyChatFont(16);
  check('写 --chat-fs', styleStore['--chat-fs'] === '16', JSON.stringify(styleStore));
  check('写 --chat-scale = 16/14', styleStore['--chat-scale'] === String(16 / 14));
  check('持久化到 localStorage', localStorage.getItem('teleforge.chat.font.v1') === '16');
  check('读回来是 16', readChatFont() === 16);
  check('当前值同步', currentChatFont() === 16);
}

// ---- 2. 越界与非法输入一律钳制到可选档位区间 ----
{
  applyChatFont(999);
  check('上限钳到最大档', currentChatFont() === CHAT_FONT_SIZES[CHAT_FONT_SIZES.length - 1]);
  applyChatFont(1);
  check('下限钳到最小档', currentChatFont() === CHAT_FONT_SIZES[0]);
  applyChatFont(NaN);
  check('NaN 回落默认', currentChatFont() === 14);
  localStorage.setItem('teleforge.chat.font.v1', '搞坏它');
  check('持久化值非法时回落默认', readChatFont() === 14);
  localStorage.setItem('teleforge.chat.font.v1', '99');
  check('持久化值越界时回落默认', readChatFont() === 14);
}

// ---- 3. 快捷键按档位步进(不是按 1px 漂移) ----
{
  applyChatFont(14);
  check('放大 → 15', stepChatFont(1) === 15);
  check('再放大 → 16', stepChatFont(1) === 16);
  check('缩小 → 15', stepChatFont(-1) === 15);
  applyChatFont(CHAT_FONT_SIZES[CHAT_FONT_SIZES.length - 1]);
  check('已在最大档时放大不变', stepChatFont(1) === CHAT_FONT_SIZES[CHAT_FONT_SIZES.length - 1]);
  applyChatFont(CHAT_FONT_SIZES[0]);
  check('已在最小档时缩小不变', stepChatFont(-1) === CHAT_FONT_SIZES[0]);
}

// ---- 4. 每模型推理等级:未声明 = 全部;声明后只留支持的 + 默认 ----
{
  const all = supportedLevels(undefined);
  check('未声明 → 全部 6 档', all.length === REASONING_LEVELS.length);
  const few = supportedLevels(['low', 'max']);
  check('只列支持的档位', few.map((lv) => lv.id).join(',') === 'default,low,max', few.map((lv) => lv.id).join(','));
  const withDefault = supportedLevels(['default', 'high']);
  check('显式含默认时不重复', withDefault.map((lv) => lv.id).join(',') === 'default,high');
  const dirty = supportedLevels(['low', 'bogus', 42]);
  check('非法档位被丢掉、默认始终保留', dirty.map((lv) => lv.id).join(',') === 'default,low');
  check('空数组等同未声明', supportedLevels([]).length === REASONING_LEVELS.length);
  check('isReasoningLevelId 认已知档', isReasoningLevelId('xhigh') && !isReasoningLevelId('ludicrous'));
  check('modelSupportedLevels 读 modelConfig', modelSupportedLevels({ reasoningLevels: ['off'] }).map((lv) => lv.id).join(',') === 'default,off');
  check('levelsSummary 全选写「全部」', levelsSummary(REASONING_LEVELS) === '全部');
  check('levelsSummary 部分选择拼接标签', levelsSummary(supportedLevels(['low', 'max'])) === '默认·低·最高');
}

console.log(`\n结果:${pass} 通过,${fail} 失败`);
if (fail > 0) process.exitCode = 1;
