// WebSocket 客户端:自动重连 + 事件订阅 + 请求/应答(reqId)
// 服务端消息为动态 JSON,类型上以宽松的 ServerMsg 描述,具体字段在各组件按需读取

type Handler = (m: any) => void;

interface Waiter {
  resolve: (m: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  replyType: string | null;
}

export class Api {
  private ws: WebSocket | null = null;
  private queue: string[] = [];
  private reqId = 0;
  private waiters = new Map<number, Waiter>();
  private handlers = new Map<string, Set<Handler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private manualClose = false;
  private connected = false;

  connect() {
    if (this.ws) return;
    this.manualClose = false;
    this._open();
  }

  private _open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.connected = true;
      this.emit('open');
      for (const m of this.queue) ws.send(m);
      this.queue = [];
      this.send('get_status', {});
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      this._handle(m);
    };
    ws.onclose = () => {
      this.ws = null;
      this.connected = false;
      this.emit('close');
      if (!this.manualClose) this._scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  private _scheduleReconnect() {
    const d = Math.min(1000 * Math.pow(2, this.attempt), 10000);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualClose) this._open();
    }, d);
  }

  send(type: string, payload: Record<string, unknown> = {}) {
    const msg = JSON.stringify({ type, ...payload });
    if (this.ws && this.ws.readyState === 1) this.ws.send(msg);
    else this.queue.push(msg);
  }

  request(type: string, payload: Record<string, unknown> = {}, timeout = 30000, replyType: string | null = null): Promise<any> {
    const reqId = ++this.reqId;
    const full = { ...payload, reqId };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(reqId);
        reject(new Error('请求超时'));
      }, timeout);
      this.waiters.set(reqId, { resolve, reject, timer, replyType });
      this.send(type, full);
    });
  }

  private _handle(m: any) {
    if (m.reqId) {
      const w = this.waiters.get(m.reqId);
      if (w) {
        if (m.error) {
          clearTimeout(w.timer);
          this.waiters.delete(m.reqId);
          w.reject(new Error(m.error));
          return;
        }
        // 指定了 replyType 时,只把该类型的消息当作最终应答;
        // 期间的同 reqId 进度事件(如 delete_progress)继续走事件分发,不提前 resolve
        if (!w.replyType || m.type === w.replyType) {
          clearTimeout(w.timer);
          this.waiters.delete(m.reqId);
          w.resolve(m);
          return;
        }
      }
    }
    if (m.type === 'error' && !m.reqId) this.emit('server_error', m);
    const hs = this.handlers.get(m.type);
    if (hs) for (const h of hs) h(m);
  }

  on(type: string, handler: Handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }
  private emit(type: string, data?: unknown) {
    const hs = this.handlers.get(type);
    if (hs) for (const h of hs) h(data);
  }

  close() {
    this.manualClose = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
  }
}

export const api = new Api();