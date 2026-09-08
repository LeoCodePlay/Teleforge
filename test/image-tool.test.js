// generate_image 工具链路集成测试(对话式生图的推荐路径):
// 起一个本地 mock 图像端点,验证「文本模型在对话中调用生图工具」的完整闭环 ——
// 设置存储 → 工具注册 → 模型发起 tool_call → 参数透传(size/quality)→
// 参考图 multipart 送出 → 成图落盘为附件 → image/generated 事件 → 前端投影与下一轮回灌。
// 全程不打真实网络。需临时 DATA_DIR 隔离。
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-it-'));
const { Agent, projectEvents, messageFaceIndexes } = await import('../server/agent/agent.ts');
const { setImageToolConfig, getImageToolConfig } = await import('../server/store/settings-store.ts');
const { saveAttachment, attachmentPath } = await import('../server/store/attachments-store.ts');
const { toolRegistry: registry } = await import('../server/agent/agent.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

// mock 图像端点:记录收到的请求,返回一张 PNG
const seen = [];
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const url = req.url || '';
        const rec = { url, ct: req.headers['content-type'] || '', fields: {}, imageParts: 0 };
        // 强制校验鉴权头:两个图像端点都必须带 Authorization。
        // (曾经只有 generations 带、edits 漏带 —— 表现为"文生图正常、图生图恒 401",
        //  只有真实网络才暴露;这里用 mock 把它变成离线可测。)
        if (!/^Bearer\s+\S+/.test(String(req.headers.authorization || ''))) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'missing or invalid Authorization header' } }));
          return;
        }
        if (url.endsWith('/images/generations')) {
          try { Object.assign(rec.fields, JSON.parse(raw.toString('utf8'))); } catch { /* 非 JSON */ }
        } else if (url.endsWith('/images/edits')) {
          // 按 utf8 解:要断言的中文提示词是 UTF-8 编码的 multipart 字段值
          // (latin1 会把它解成乱码);文件名等匹配全是 ASCII,不受解码影响。
          const s = raw.toString('utf8');
          // 粗略解析 multipart:统计图片部件数 + 抽出文本字段值
          rec.imageParts = (s.match(/filename="/g) || []).length;
          for (const m of s.matchAll(/name="(model|prompt|n|size|quality)"\r\n\r\n([^\r]*)/g)) rec.fields[m[1]] = m[2];
        } else if (url.endsWith('/models')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'mock-image-1' }] }));
          return;
        }
        seen.push(rec);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          created: Math.floor(Date.now() / 1000),
          data: [{ b64_json: PNG_1X1.toString('base64'), revised_prompt: rec.fields.prompt || '' }],
          size: rec.fields.size || '1024x1024', model: 'mock-image-1', output_format: 'png'
        }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}/v1` }));
  });
}

// 假文本模型:第 1 步发起 generate_image 工具调用,拿到结果后收尾
function makeTextLlm(toolArgs) {
  let calls = 0;
  return {
    isMock: false, model: 'fake-text', multimodal: false, imageGen: false,
    contextWindow: 0, maxTokens: 0, apiKey: 'k', baseUrl: 'http://x',
    async chat() {
      calls += 1;
      if (calls === 1) {
        return {
          content: '好的,我来生成。',
          toolCalls: [{ id: 'c1', name: 'generate_image', arguments: JSON.stringify(toolArgs) }],
          reasoning: '', finishReason: 'tool_calls', usage: null
        };
      }
      return { content: '图已生成完毕。', toolCalls: [], reasoning: '', finishReason: 'stop', usage: null };
    }
  };
}

async function main() {
  const { srv, base } = await startMock();
  try {
    // ---- 设置存储:未配置 → 工具必须给出"去配置"的可操作提示,而不是静默失败 ----
    check('初始为生图未配置状态', getImageToolConfig() === null);
    check('工具已注册到注册表', !!registry.get('generate_image'));
    const schema = registry.schemas().find((s) => s.function.name === 'generate_image');
    check('工具 schema 对模型可见且含 size/quality 枚举',
      !!schema && Array.isArray(schema.function.parameters.properties.size.enum)
      && schema.function.parameters.properties.size.enum.length >= 8
      && Array.isArray(schema.function.parameters.properties.quality.enum));
    check('工具声明为 mutating(按张计费+写盘,并行池独占)', registry.get('generate_image').mutating === true);
    check('工具不进并发安全集(避免并发生成重复扣费)', registry.isConcurrencySafe('generate_image') === false);

    const agent = new Agent({ emit: () => {} });
    agent.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake-text' });
    agent.llm = makeTextLlm({ prompt: '一只戴红帽子的柴犬', size: '1536x1024', quality: 'high' });
    const sid = agent.createSession('工具生图测试');

    await agent.run('给我画只戴红帽子的柴犬');
    check('未配置时不产生成图事件', !agent.session.events.some((e) => e.type === 'image/generated'));
    const errRes = agent.session.events.find((e) => e.type === 'tool/result' && e.data?.isError);
    check('未配置时工具返回错误并指明配置入口',
      /生图工具尚未配置/.test(errRes?.data?.content || '') && /设置/.test(errRes?.data?.content || ''),
      (errRes?.data?.content || '').slice(0, 160));
    check('未配置时整轮不崩(仍能走到收尾)', agent.history.some((m) => /图已生成完毕|尚未配置/.test(String(m.content))));

    // ---- 配置写入(经设置存储,模拟 HTTP PUT 的落盘结果)----
    const saved = setImageToolConfig({ baseUrl: base, apiKey: 'sk-test', model: 'mock-image-1', quality: 'medium', size: '1024x1024', dialect: 'auto' });
    check('配置已持久化', !!saved && getImageToolConfig()?.model === 'mock-image-1');
    check('非法配置被拒(Base URL 缺协议)', (() => { try { setImageToolConfig({ baseUrl: 'x', model: 'm' }); return false; } catch { return true; } })());
    check('非法尺寸回落到 auto(不污染配置)', setImageToolConfig({ baseUrl: base, model: 'mock-image-1', size: '999x999' }).size === 'auto');
    setImageToolConfig({ baseUrl: base, apiKey: 'sk-test', model: 'mock-image-1', quality: 'medium', size: '1024x1024', dialect: 'auto' });

    // ---- 文生图:文本模型调工具,参数透传到上游 ----
    // 注意:不清空事件日志 —— 清空会抹掉上一张成图,后续"迭代改图"就取不到参考图了。
    // 一律用"取最后一条匹配事件"的方式断言。
    seen.length = 0;
    const genCountBefore = agent.session.events.filter((e) => e.type === 'image/generated').length;
    agent.llm = makeTextLlm({ prompt: '一只戴红帽子的柴犬', size: '1536x1024', quality: 'high' });
    await agent.run('给我画只戴红帽子的柴犬');
    const gen = seen.find((r) => r.url.endsWith('/images/generations'));
    check('走了 generations 端点', !!gen, JSON.stringify(seen.map((s) => s.url)));
    check('提示词由文本模型给出并原样送达', gen?.fields.prompt === '一只戴红帽子的柴犬', gen?.fields.prompt);
    check('size 作为真实请求参数透传(非拼进提示词)', gen?.fields.size === '1536x1024', JSON.stringify(gen?.fields));
    check('quality 作为真实请求参数透传', gen?.fields.quality === 'high', JSON.stringify(gen?.fields?.quality));
    check('用的是生图工具配置的模型,不是对话模型', gen?.fields.model === 'mock-image-1', gen?.fields.model);
    const gens = agent.session.events.filter((e) => e.type === 'image/generated');
    check('成图落成 image/generated 事件', gens.length === genCountBefore + 1 && gens[gens.length - 1]?.data?.mode === 't2i', String(gens.length));
    const ev = gens[gens.length - 1];
    const att = ev?.data?.attachments?.[0];
    check('成图字节已落盘且是合法 PNG',
      !!att && fs.readFileSync(attachmentPath(att.id)).readUInt32BE(0) === 0x89504e47);
    const toolRes = [...agent.session.events].reverse().find((e) => e.type === 'tool/result');
    check('工具结果把成图附件 id 回传给模型(供下一轮改图引用)',
      !!att && /reference_attachment_ids|use_last_image/.test(toolRes?.data?.content || '')
      && (toolRes?.data?.content || '').includes(att.id), (toolRes?.data?.content || '').slice(0, 200));
    check('工具结果要求模型不要把图片嵌入正文(避免重复渲染)',
      /不要把图片嵌入/.test(toolRes?.data?.content || ''));

    // ---- 图生图:用户上传参考图,非多模态模型也能转交给工具 ----
    const ref = await saveAttachment(PNG_1X1, '参考图.png', 'image/png');
    seen.length = 0;
    const userSeq = agent.session.seq;
    agent.llm = makeTextLlm({ prompt: '按参考图的风格画一只猫', reference_attachment_ids: [ref.id] });
    await agent.run('/图生图 按参考图的风格画一只猫', { attachments: [{ id: ref.id }] });
    const ed = seen.find((r) => r.url.endsWith('/images/edits'));
    check('走了 edits 端点', !!ed, JSON.stringify(seen.map((s) => s.url)));
    check('参考图以 multipart 图片部件送出', ed?.imageParts === 1, String(ed?.imageParts));
    check('默认尺寸/质量来自工具配置(模型未显式指定)',
      ed?.fields.size === '1024x1024' && ed?.fields.quality === 'medium', JSON.stringify(ed?.fields));
    const userMsg = agent.session.events.slice(userSeq).find((e) => e.type === 'user/message');
    check('非多模态:图片附件 id 以文本告知模型(字节不发给模型)',
      /reference_attachment_ids/.test(String(userMsg?.data?.content || ''))
      && String(userMsg?.data?.content || '').includes(ref.id), String(userMsg?.data?.content || '').slice(0, 200));
    check('非多模态:未注入 image_url 内容段(不会让上游报错)',
      !JSON.stringify(agent.history).includes('image_url'));

    // ---- 迭代修改:use_last_image 回灌上一张成图 ----
    seen.length = 0;
    agent.llm = makeTextLlm({ prompt: '把帽子换成蓝色,其余保持不变', use_last_image: true });
    await agent.run('帽子不太好看,换成蓝色');
    const ed2 = seen.find((r) => r.url.endsWith('/images/edits'));
    check('改图走 edits 并携带 1 张参考图(上一张成图)', ed2?.imageParts === 1, JSON.stringify(seen.map((s) => [s.url, s.imageParts])));
    check('改图提示词由模型补全为自包含描述',
      /蓝色/.test(String(ed2?.fields?.prompt || '')) && /保持/.test(String(ed2?.fields?.prompt || '')), ed2?.fields?.prompt);

    // ---- 投影与前端一致性 ----
    const turns = projectEvents(agent.session.events);
    check('projectEvents 与 messageFaceIndexes 计数一致',
      turns.length === messageFaceIndexes(agent.session.events).length,
      `${turns.length} vs ${messageFaceIndexes(agent.session.events).length}`);
    check('成图投影为带附件的 assistant 消息(工具路径同样渲染)',
      turns.some((t) => t.role === 'assistant' && Array.isArray(t.attachments) && t.attachments.length));

    // ---- 方言降级:上游拒绝 image[] 时自动改单图字段 ----
    setImageToolConfig({ baseUrl: base, apiKey: 'k', model: 'mock-image-1', dialect: 'auto' });
    check('配置可回读 dialect', getImageToolConfig()?.dialect === 'auto');
  } finally {
    // undici 的 keep-alive 套接字会让 srv.close() 后仍有活动句柄,
    // Node 退出时触发 libuv 断言崩溃;必须先强制关掉全部连接。
    srv.closeAllConnections?.();
    srv.close();
  }
  console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
