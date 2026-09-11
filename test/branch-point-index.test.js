// 分支点下标(forkTail = 回退/删除/分支用的消息面下标)必须与服务端 messageFaceIndexes 一致。
// 回归的线上故障:模型请求以 402「余额不足」失败后再点「回到本轮对话发起前」,报
// 「目标不是用户消息,无法回退」。根因是前端本地计数器是"猜"的——
//   * 每个 step 开跑前广播 iteration,前端就 +1,但请求失败的 step 不会落 assistant/message;
//   * 轮末自愈补的工具结果(中止时)只有服务端计数;
//   * 生图轮一轮落 assistant/message + image/generated 两个消息面,前端只 +1。
// 猜出的下标漂移后,下一条用户消息带着错的下标去回退,命中的就是别的消息面。
// 修法:服务端在轮末广播 turn_end(faceCount) 给前端重锚、压缩标记行广播 at 供平移。
// 本测试既校验这些广播的权威性,也校验"按前端口径模拟的计数器"在每轮 start 时与服务端一致。
// 注意:本测试写会话历史,需在临时 DATA_DIR 里隔离运行。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-branch-index-'));

const { Agent, messageFaceIndexes } = await import('../server/agent/agent.ts');
const { sshManager: ssh } = await import('../server/core/ssh-manager.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };
const finish = () => { console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`); if (fail) process.exit(1); };

ssh.status = 'connected';
ssh.platform = 'posix';
ssh.workspace = '/home';
ssh.hostInfo = { host: 'h', port: 22, username: 'u' };

// 前端口径的分支点计数器(ChatPanel: start/iteration/tool_result 各自推进,turn_end 重锚)。
// 逐字复刻事件处理口径,用来断言"前端算出来的下标"与"服务端消息面下标"一致。
function makeFrontCounter(onStart) {
  const state = { counter: 0, lastIter: 0, starts: [] };
  return {
    state,
    feed(p) {
      if (!p || typeof p.event !== 'string') return;
      if (p.event === 'start') {
        onStart(state.counter); // 此刻服务端还没 append 本条 user/message:base 就是它的下标
        state.counter += 1;
        state.lastIter = 0;
      } else if (p.event === 'iteration') {
        if (p.iter !== state.lastIter) { state.counter += 1; state.lastIter = p.iter; }
      } else if (p.event === 'tool_result') {
        state.counter += 1;
      } else if (p.event === 'compaction_done' && typeof p.at === 'number') {
        state.counter += 1; // 压缩标记行占一个消息面
      } else if (p.event === 'turn_end' && typeof p.faceCount === 'number') {
        state.counter = p.faceCount; // 权威重锚(本次修复的关键)
      }
    }
  };
}

// 假文本模型:第 failOnCall 次调用抛 402(模拟余额不足),其余正常收尾
function makeFakeLlm({ failOnCall = 0 } = {}) {
  let calls = 0;
  return {
    isMock: false,
    model: 'fake',
    contextWindow: 0,
    maxTokens: 100,
    apiKey: 'k',
    baseUrl: 'http://x',
    async chat() {
      calls += 1;
      if (failOnCall && calls === failOnCall) {
        throw new Error('LLM API 402 [model=deepseek-flash]: {"code":"INSUFFICIENT_BALANCE","message":"余额不足","data":{"retryAfterSeconds":23},"traceId":"trace_x"}');
      }
      return { content: `第 ${calls} 次回答`, toolCalls: [] };
    }
  };
}

/** 建一个接了假模型、并挂上"前端计数器"探针的 agent */
function makeAgent(llm) {
  const ctx = { agent: null };
  const starts = [];
  const front = makeFrontCounter((counterBefore) => {
    // 服务端口径的 base:start 广播时下一个消息面(本轮 user/message)将占用的下标
    starts.push({ counterBefore, serverBase: messageFaceIndexes(ctx.agent.session.events).length });
  });
  const agent = new Agent({
    emit: (e, p) => { if (e === 'agent') front.feed(p); }
  });
  ctx.agent = agent;
  agent.llm = llm;
  agent.llmConfigured = true;
  ctx.front = front;
  ctx.starts = starts;
  return ctx;
}

const faceIdxOfUserText = (agent, text) => {
  const events = agent.session.events;
  const faces = messageFaceIndexes(events);
  for (const i of faces) {
    const ev = events[i];
    if (ev.type === 'user/message' && ev.data?.source === 'user' && String(ev.data.content || '').includes(text)) return faces.indexOf(i);
  }
  return -1;
};

async function main() {
  // ---- 场景 1:成功轮 → 402 失败轮 → 再发一条(线上故障的原始路径) ----
  console.log('\n[场景 1] 402 失败轮之后再发消息:下标不漂移,回退命中用户消息');
  {
    const { agent, starts } = makeAgent(makeFakeLlm({ failOnCall: 2 }));
    await agent.run('第一轮问题');
    await agent.run('第二轮问题');           // 这次请求 402
    const events1 = agent.session.events;
    check('第二轮以 error 收尾(模拟 402)',
      events1.some((e) => e.type === 'turn/end' && e.data?.reason?.kind === 'error'
        && /402/.test(String(e.data.reason.error || ''))),
      JSON.stringify(events1.filter((e) => e.type === 'turn/end').map((e) => e.data.reason)));
    check('失败轮不落 assistant/message(只有 user + 运行时快照)',
      events1.filter((e) => e.type === 'assistant/message').length === 1);

    // 失败轮之后,前端计数器必须已被 turn_end 重锚回服务端口径:
    // start 广播时 counterBefore === 该用户消息的服务端下标(旧代码这里是 counterBefore = serverBase+1)
    await agent.run('第三轮问题');
    const s2 = starts[1], s3 = starts[2];
    check('第 2 轮 start:前端 base === 服务端 base', s2.counterBefore === s2.serverBase, JSON.stringify(s2));
    check('第 3 轮 start:失败轮重锚后前端 base === 服务端 base', s3.counterBefore === s3.serverBase, JSON.stringify(s3));

    // 线上复现:旧口径(丢了 turn_end 重锚)算出的下标,命中的正是第三轮的 assistant 回复
    const staleAt = s3.serverBase + 1;
    const events3 = agent.session.events;
    const hitType = events3[messageFaceIndexes(events3)[staleAt]]?.type;
    check('旧口径下标的落点确实不是用户消息(证明本测试覆盖了该漂移)',
      hitType === 'assistant/message', `staleAt=${staleAt} 命中=${hitType}`);
    let staleErr = '';
    try { agent.rewindToBefore(staleAt); } catch (e) { staleErr = String(e.message || e); }
    check('旧口径回退报「目标不是用户消息」(复现原故障)', /目标不是用户消息/.test(staleErr), staleErr);
    check('报错时不改日志', agent.session.events.length === events3.length);

    // 权威下标回退:回到第三轮发起前,第三轮整轮移除,前两轮保留
    const at3 = faceIdxOfUserText(agent, '第三轮问题');
    check('权威下标 = 第 3 轮用户消息的消息面下标', at3 === s3.serverBase, `at3=${at3} base=${s3.serverBase}`);
    agent.rewindToBefore(at3);
    const after = agent.session.events;
    check('回退成功:第三轮用户消息已移除',
      !after.some((e) => e.type === 'user/message' && String(e.data?.content || '').includes('第三轮问题')));
    check('回退成功:第一轮内容保留',
      after.some((e) => e.type === 'user/message' && String(e.data?.content || '').includes('第一轮问题')));
    check('回退成功:第二轮的失败记录也还在(只截断目标轮及其之后)',
      after.some((e) => e.type === 'user/message' && String(e.data?.content || '').includes('第二轮问题')));
  }

  // ---- 场景 2:生图轮(一轮 = 两个消息面)之后的下标照样对齐 ----
  console.log('\n[场景 2] 生图轮之后接着发消息:image/generated 多出的消息面被计入');
  {
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const imageLlm = {
      isMock: false, model: 'fake-image', imageGen: true, multimodal: false,
      contextWindow: 0, maxTokens: 0, apiKey: 'k', baseUrl: 'http://x',
      async generateImage() { return [{ buf: PNG, mime: 'image/png', size: '1024x1024', model: 'fake-image' }]; },
      async editImage() { return [{ buf: PNG, mime: 'image/png', size: '1024x1024', model: 'fake-image' }]; },
      async chat() { throw new Error('生图轮不该走 chat()'); }
    };
    const { agent, starts } = makeAgent(imageLlm);
    agent.createSession('生图轮'); // 独立会话,避免继承同进程内上一个场景的日志
    await agent.run('画一只猫');
    const faceAfterImage = messageFaceIndexes(agent.session.events).length;
    check('生图轮落两个消息面(assistant/message + image/generated)= 3 条',
      faceAfterImage === 3, `faceCount=${faceAfterImage} types=${agent.session.events.map((e) => e.type).join(',')}`);

    // 切回文本模型继续对话:这一轮的用户消息下标必须等于服务端 base
    agent.llm = makeFakeLlm();
    await agent.run('接着聊');
    const s2 = starts[1];
    check('生图轮后 start:前端 base === 服务端 base', s2.counterBefore === s2.serverBase, JSON.stringify(s2));
    check('该 base 指向的正是本轮用户消息',
      agent.session.events[messageFaceIndexes(agent.session.events)[s2.serverBase]]?.type === 'user/message');
    let err = '';
    try { agent.rewindToBefore(s2.serverBase); } catch (e) { err = String(e.message || e); }
    check('生图轮后回退不回退错、也不报错', err === '', err);
    check('回退只移除文本轮user消息,生图轮完整保留',
      agent.session.events.some((e) => e.type === 'image/generated')
      && !agent.session.events.some((e) => e.type === 'user/message' && String(e.data?.content || '').includes('接着聊')));
  }

  // ---- 场景 3:失败轮就是最后一轮时,直接回退这一轮(用户报的原始操作路径) ----
  console.log('\n[场景 3] 402 后直接回退刚失败的那一轮');
  {
    const { agent, starts } = makeAgent(makeFakeLlm({ failOnCall: 2 }));
    agent.createSession('失败轮回退');
    await agent.run('第一轮问题');
    await agent.run('第二轮问题'); // 402
    const at = starts[1].serverBase;
    check('失败轮 start 时前端 base === 服务端 base', starts[1].counterBefore === at, JSON.stringify(starts[1]));
    let err = '';
    try { agent.rewindToBefore(at); } catch (e) { err = String(e.message || e); }
    check('回退失败轮不报「目标不是用户消息」', err === '', err);
    check('失败轮已被移除', !agent.session.events.some((e) => e.type === 'user/message' && String(e.data?.content || '').includes('第二轮问题')));
    check('第一轮保留', agent.session.events.some((e) => e.type === 'user/message' && String(e.data?.content || '').includes('第一轮问题')));
  }

  finish();
}
main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
