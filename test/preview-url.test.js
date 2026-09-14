// 前端预览相关纯函数测试:地址识别 / 归一化 / 提取 / 标签名 / 触摸拖动方向 / 预览归属(无需浏览器,秒级跑完)
import {
  isPreviewUrl, isPreviewHost, isHttpLink, normalizePreviewInput, extractPreviewUrls, previewLabel, touchDragDelta,
  BROWSER_TAB_PREFIX, allocBrowserId, browserSessionId, browserTabId, countPreviewTabs, isSessionScoped,
  newDraftSessionId, ownerOfBrowserId, ownerSessionLabel
} from '../web/src/utils/preview.ts';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

// ---- 该不该用内置预览打开 ----
check('localhost 算预览地址', isPreviewUrl('http://localhost:5173/'));
check('127.0.0.1 算预览地址', isPreviewUrl('http://127.0.0.1:3000/'));
check('私有网段 IP 算预览地址', isPreviewUrl('http://192.168.1.7:8080/x'));
check('带非标准端口的域名算预览地址', isPreviewUrl('http://dev.internal.lan:9000/'));
check('公网无端口域名不算', !isPreviewUrl('https://example.com/docs'));
check('无协议文本不算', !isPreviewUrl('localhost:5173'));
check('主机名判定:回环/私有/内网后缀', isPreviewHost('localhost') && isPreviewHost('10.1.2.3') && isPreviewHost('box.local') && !isPreviewHost('example.com'));

// ---- 聊天里点到的 http(s) 链接一律接管:桌面壳放行 webview 自己导航会把整个应用页面换掉 ----
check('公网链接也要接管', isHttpLink('https://github.com/LeoCodePlay/Teleforge/releases/tag/v0.2.0'));
check('本地地址同样接管', isHttpLink('http://localhost:5173/'));
check('锚点不接管', !isHttpLink('#section'));
check('mailto 不接管', !isHttpLink('mailto:dev@example.com'));
check('相对路径不接管', !isHttpLink('/docs/guide.md'));
check('无协议文本不接管', !isHttpLink('github.com/LeoCodePlay/Teleforge'));

// ---- 地址栏输入归一化 ----
check('localhost:5173 补协议', normalizePreviewInput('localhost:5173') === 'http://localhost:5173');
check('裸端口补到 localhost', normalizePreviewInput('5173') === 'http://localhost:5173');
check('带协议原样保留', normalizePreviewInput('https://example.com/a') === 'https://example.com/a');
check('清洗尖括号与句末标点', normalizePreviewInput('<http://127.0.0.1:8080/x>,') === 'http://127.0.0.1:8080/x');
check('普通文本返回 null', normalizePreviewInput('帮我看看这个') === null);

// ---- 从文本里提取地址 ----
const got = extractPreviewUrls('ready\n➜ Local: http://localhost:5173/\n➜ Network: http://10.0.0.5:5173/\nsee https://example.com');
check('提取本地地址并忽略公网链接', got.length === 2 && got[0].includes('localhost:5173'), JSON.stringify(got));
check('重复地址去重', extractPreviewUrls('http://localhost:3000 http://localhost:3000').length === 1);

// ---- 标签名 ----
check('127.0.0.1 显示成 localhost', previewLabel('http://127.0.0.1:5173/a/b') === 'localhost:5173');
check('普通域名带端口', previewLabel('http://dev.lan:9000/') === 'dev.lan:9000');

// ---- 触摸拖动方向(最容易写反、肉眼又看不出来的一处) ----
const up = touchDragDelta({ x: 100, y: 300 }, { x: 100, y: 240 });   // 手指上滑
check('手指上滑 → deltaY 为正(页面下滚)', up.dy === 60 && up.dx === 0, JSON.stringify(up));
const down = touchDragDelta({ x: 100, y: 240 }, { x: 100, y: 300 }); // 手指下滑
check('手指下滑 → deltaY 为负(页面上滚)', down.dy === -60, JSON.stringify(down));
const left = touchDragDelta({ x: 300, y: 100 }, { x: 220, y: 100 }); // 手指左滑
check('手指左滑 → deltaX 为正(内容左移)', left.dx === 80, JSON.stringify(left));

// ---- 预览标签 ↔ 会话归属(一个预览只服务一个对话) ----
check('标签 id = 前缀 + 浏览器会话 id', browserTabId('s_ab12:1') === BROWSER_TAB_PREFIX + 's_ab12:1');
check('标签 id 可还原成浏览器会话 id', browserSessionId(BROWSER_TAB_PREFIX + 's_ab12:2') === 's_ab12:2');
check('非预览标签原样返回', browserSessionId('local:/tmp/a.txt') === 'local:/tmp/a.txt');
check('归属会话可从浏览器 id 解析', ownerOfBrowserId('s_ab12:2') === 's_ab12');
check('草稿会话也是合法归属', ownerOfBrowserId('d_x9:1') === 'd_x9');
check('无归属的共享预览(旧版 main)', ownerOfBrowserId('main') === null);
check('会话标识校验:真实/草稿/其它',
  isSessionScoped('s_ab12') && isSessionScoped('d_ab12') && !isSessionScoped('main') && !isSessionScoped('__new__'));

// 同一会话内多开:分配空闲序号,不撞已有 id
const used = ['s_a1:1', 's_a1:2', 's_b2:1'];
check('会话内多开分配 :3', allocBrowserId(used, 's_a1') === 's_a1:3');
check('别的会话的用量不干扰', allocBrowserId(used, 's_b2') === 's_b2:2');
check('全新会话从 :1 开始', allocBrowserId(used, 's_c3') === 's_c3:1');
check('统计某会话的预览数量', countPreviewTabs(used, 's_a1') === 2 && countPreviewTabs(used, 's_c3') === 0);

// 草稿会话每次进入草稿态都要拿到不同的占位 id(否则两个新会话的预览会撞在同一个归属上)
const d1 = newDraftSessionId();
const d2 = newDraftSessionId();
check('草稿会话 id 唯一且可识别', d1 !== d2 && isSessionScoped(d1) && isSessionScoped(d2), `${d1} / ${d2}`);

// 左下角显示的会话名
check('有标题用标题', ownerSessionLabel('s_a1', '修登录页') === '修登录页');
check('无标题回落会话 id', ownerSessionLabel('s_a1') === 's_a1');
check('草稿态给出人话', ownerSessionLabel('d_x9') === '新会话(尚未发送)');
check('无归属说明是共享预览', ownerSessionLabel(null).includes('共享预览'));

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
