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
const { imageProviders, usableImageKeys } = await import('../server/store/image-providers-store.ts');
const { resolveImageTool } = await import('../server/agent/image-gen.ts');
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
const auths = []; // 每个请求实际带的 Authorization(多 Key 轮询断言用)
let rejectMultipartEdits = false; // 模拟「只收 JSON base64、拒收文件上传」的网关(实测 api.tk1688.com)
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const url = req.url || '';
        const rec = { url, ct: req.headers['content-type'] || '', fields: {}, imageParts: 0 };
        const auth = String(req.headers.authorization || '');
        auths.push(auth);
        // 强制校验鉴权头:两个图像端点都必须带 Authorization。
        // (曾经只有 generations 带、edits 漏带 —— 表现为"文生图正常、图生图恒 401",
        //  只有真实网络才暴露;这里用 mock 把它变成离线可测。)
        if (!/^Bearer\s+\S+/.test(auth)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'missing or invalid Authorization header' } }));
          return;
        }
        // 固定把 sk-dead 判为鉴权失败:用于验证「第一个 Key 失效 → 自动换下一个」
        if (auth === 'Bearer sk-dead') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
          return;
        }
        if (url.endsWith('/images/generations')) {
          try { Object.assign(rec.fields, JSON.parse(raw.toString('utf8'))); } catch { /* 非 JSON */ }
        } else if (url.endsWith('/images/edits')) {
          const ct = String(req.headers['content-type'] || '');
          if (rejectMultipartEdits && ct.includes('multipart/form-data')) {
            seen.push({ ...rec, rejected: true });
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: { message: 'reference image uploads are not supported by this gateway', type: 'new_api_error' }
            }));
            return;
          }
          if (ct.includes('application/json')) {
            // JSON 方言:参考图放在 image 里(data URL 字符串或数组)
            try { rec.jsonBody = JSON.parse(raw.toString('utf8')); } catch { rec.jsonBody = null; }
            Object.assign(rec.fields, rec.jsonBody || {});
          } else {
            // 按 utf8 解:要断言的中文提示词是 UTF-8 编码的 multipart 字段值
            // (latin1 会把它解成乱码);文件名等匹配全是 ASCII,不受解码影响。
            const s = raw.toString('utf8');
            // 粗略解析 multipart:统计图片部件数 + 抽出文本字段值
            rec.imageParts = (s.match(/filename="/g) || []).length;
            for (const m of s.matchAll(/name="(model|prompt|n|size|quality)"\r\n\r\n([^\r]*)/g)) rec.fields[m[1]] = m[2];
          }
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

/** 换模型:会话跑过一轮后会锁定自己的客户端(见 agent._lockLlm),
 *  所以必须像生产路径(configureLlm(cfg, sid))那样连该会话的客户端一起换,
 *  否则下一轮还在用上一份假脚本(calls 计数已过 1 → 不再发起工具调用)。 */
function swapLlm(agent, llm) {
  agent.llm = llm;
  const sid = agent.getSessionId();
  if (sid) agent._llmBySid.set(sid, llm);
  return llm;
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
    // ---- 生图模型商 store:未配置 → 工具必须给出"去配置"的可操作提示,而不是静默失败 ----
    check('初始为生图未配置状态', imageProviders.active() === null);
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
    // 本测试验证的是生图工具链路,与权限门控无关:显式切到完全访问,
    // 否则默认 confirm 档下 generate_image(write)会挂起等待审批。
    agent.setPermissionMode('full-access');
    agent.llm = makeTextLlm({ prompt: '一只戴红帽子的柴犬', size: '1536x1024', quality: 'high' });
    const sid = agent.createSession('工具生图测试');

    await agent.run('给我画只戴红帽子的柴犬');
    check('未配置时不产生成图事件', !agent.session.events.some((e) => e.type === 'image/generated'));
    const errRes = agent.session.events.find((e) => e.type === 'tool/result' && e.data?.isError);
    check('未配置时工具返回错误并指明配置入口',
      /生图工具尚未配置/.test(errRes?.data?.content || '') && /设置/.test(errRes?.data?.content || ''),
      (errRes?.data?.content || '').slice(0, 160));
    check('未配置时整轮不崩(仍能走到收尾)', agent.history.some((m) => /图已生成完毕|尚未配置/.test(String(m.content))));

    // ---- 配置写入(经生图模型商 store,模拟 HTTP 新增的落盘结果)----
    const provider = imageProviders.add({
      name: '测试生图端点', baseUrl: base, apiKey: 'sk-test', model: 'mock-image-1',
      quality: 'medium', size: '1024x1024', dialect: 'auto'
    });
    check('配置已持久化并成为使用中', imageProviders.active()?.id === provider.id && imageProviders.active()?.model === 'mock-image-1');
    check('非法配置被拒(Base URL 缺协议)', (() => { try { imageProviders.add({ baseUrl: 'x', model: 'm' }); return false; } catch { return true; } })());
    check('非法尺寸回落到 auto(不污染配置)', imageProviders.update(provider.id, { size: '999x999' })?.size === 'auto');
    imageProviders.update(provider.id, {
      baseUrl: base, apiKey: 'sk-test', model: 'mock-image-1',
      quality: 'medium', size: '1024x1024', dialect: 'auto'
    });

    // ---- 文生图:文本模型调工具,参数透传到上游 ----
    // 注意:不清空事件日志 —— 清空会抹掉上一张成图,后续"迭代改图"就取不到参考图了。
    // 一律用"取最后一条匹配事件"的方式断言。
    seen.length = 0;
    const genCountBefore = agent.session.events.filter((e) => e.type === 'image/generated').length;
    swapLlm(agent, makeTextLlm({ prompt: '一只戴红帽子的柴犬', size: '1536x1024', quality: 'high' }));
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
    swapLlm(agent, makeTextLlm({ prompt: '按参考图的风格画一只猫', reference_attachment_ids: [ref.id] }));
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
    swapLlm(agent, makeTextLlm({ prompt: '把帽子换成蓝色,其余保持不变', use_last_image: true }));
    await agent.run('帽子不太好看,换成蓝色');
    const ed2 = seen.find((r) => r.url.endsWith('/images/edits'));
    check('改图走 edits 并携带 1 张参考图(上一张成图)', ed2?.imageParts === 1, JSON.stringify(seen.map((s) => [s.url, s.imageParts])));
    check('改图提示词由模型补全为自包含描述',
      /蓝色/.test(String(ed2?.fields?.prompt || '')) && /保持/.test(String(ed2?.fields?.prompt || '')), ed2?.fields?.prompt);

    // ---- 只收 JSON base64 的网关:multipart 被 4xx 拒 → 自动改发 JSON ----
    // (实测 api.tk1688.com 的真实行为:edits 端点带文件一律 400,改发 JSON + base64 才出图)
    rejectMultipartEdits = true;
    seen.length = 0;
    imageProviders.update(provider.id, { dialect: 'auto', apiKeys: ['sk-test'] });
    const genBeforeJson = agent.session.events.filter((e) => e.type === 'image/generated').length;
    const ref2 = await saveAttachment(PNG_1X1, '参考图2.png', 'image/png');
    swapLlm(agent, makeTextLlm({ prompt: '把背景改成蓝色', reference_attachment_ids: [ref2.id] }));
    await agent.run('把这张图的背景改成蓝色', { attachments: [{ id: ref2.id }] });
    const edRejected = seen.find((r) => r.url.endsWith('/images/edits') && r.rejected);
    const edJson = seen.find((r) => r.url.endsWith('/images/edits') && !r.rejected);
    check('multipart 被判「不收文件」后自动改发 JSON',
      !!edRejected && !!edJson, JSON.stringify(seen.map((s) => [s.ct.slice(0, 24), s.rejected ? 'rejected' : 'ok'])));
    check('JSON 方言把参考图放进 image 的 data URL 单字符串',
      /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(edJson?.jsonBody?.image || '')),
      String(edJson?.jsonBody?.image || '').slice(0, 60));
    check('JSON 方言仍带 model 与提示词',
      edJson?.jsonBody?.model === 'mock-image-1' && /蓝色/.test(String(edJson?.fields?.prompt || '')),
      JSON.stringify(edJson?.jsonBody || {}).slice(0, 160));
    check('降级只落一张图(被拒的那次不计费、不重复出图)',
      agent.session.events.filter((e) => e.type === 'image/generated').length === genBeforeJson + 1);

    // ---- 显式选 json_base64:不试探,首发即 JSON ----
    seen.length = 0;
    imageProviders.update(provider.id, { dialect: 'json_base64' });
    swapLlm(agent, makeTextLlm({ prompt: '再改一次', use_last_image: true }));
    await agent.run('再改一次');
    check('显式 json_base64 首发即 JSON(不产生 multipart 请求)',
      seen.filter((r) => r.url.endsWith('/images/edits')).length === 1 && !seen.some((r) => r.rejected),
      JSON.stringify(seen.map((s) => s.ct.slice(0, 24))));
    rejectMultipartEdits = false;
    imageProviders.update(provider.id, { dialect: 'auto' });


    // ---- 投影与前端一致性 ----
    const turns = projectEvents(agent.session.events);
    check('projectEvents 与 messageFaceIndexes 计数一致',
      turns.length === messageFaceIndexes(agent.session.events).length,
      `${turns.length} vs ${messageFaceIndexes(agent.session.events).length}`);
    check('成图投影为带附件的 assistant 消息(工具路径同样渲染)',
      turns.some((t) => t.role === 'assistant' && Array.isArray(t.attachments) && t.attachments.length));

    // ---- 多 Key 轮询:第一个 Key 401 → 自动换下一个并把判定写回模型商 ----
    imageProviders.update(provider.id, {
      apiKeys: ['sk-dead', 'sk-test'], quality: 'auto', size: 'auto', dialect: 'auto'
    });
    auths.length = 0; seen.length = 0;
    swapLlm(agent, makeTextLlm({ prompt: '多 Key 轮询测试图' }));
    await agent.run('再画一张,测试多 Key 轮询');
    check('第一个 Key 被拒后仍成功出图',
      seen.some((r) => r.url.endsWith('/images/generations')), JSON.stringify(seen.map((s) => s.url)));
    check('确实先用了 sk-dead,再切到 sk-test',
      auths.includes('Bearer sk-dead') && auths.includes('Bearer sk-test'), JSON.stringify(auths));
    const afterRotate = imageProviders.find(provider.id);
    check('失效 Key 被标记为鉴权失败',
      afterRotate?.keyStates?.['sk-dead']?.invalid === true, JSON.stringify(afterRotate?.keyStates));
    check('后续轮询不再包含失效 Key',
      usableImageKeys(afterRotate).join(',') === 'sk-test', usableImageKeys(afterRotate).join(','));

    // ---- 全部 Key 不可用:直接给可操作错误,不发无鉴权请求 ----
    imageProviders.markKeyExhausted(provider.id, 'sk-test', 'quota', 'balance');
    let unusableMsg = '';
    try { resolveImageTool(); } catch (e) { unusableMsg = e.message; }
    check('全部 Key 不可用时提示重置/更换',
      /全部 API Key 都不可用/.test(unusableMsg) && /生图配置/.test(unusableMsg), unusableMsg);
    imageProviders.resetAllKeys(provider.id);
    check('重置后恢复参与轮询',
      usableImageKeys(imageProviders.find(provider.id)).join(',') === 'sk-dead,sk-test');

    // ---- 方言配置可回读 ----
    imageProviders.update(provider.id, { dialect: 'auto' });
    check('配置可回读 dialect', imageProviders.active()?.dialect === 'auto');
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
