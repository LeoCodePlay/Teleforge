// 前端预览相关纯函数测试:地址识别 / 归一化 / 提取 / 标签名 / 触摸拖动方向(无需浏览器,秒级跑完)
import {
  isPreviewUrl, isPreviewHost, normalizePreviewInput, extractPreviewUrls, previewLabel, touchDragDelta
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

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
