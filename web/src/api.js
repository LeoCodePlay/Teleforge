// WebSocket 客户端:自动重连 + 事件订阅 + 请求/应答(reqId)
export class Api {
  constructor() {
    this.ws = null;
    this.queue = [];
    this.reqId = 0;
    this.waiters = new Map();
    this.handlers = new Map();
    this.reconnectTimer = null;
    this.attempt = 0;
    this.manualClose = false;
    this.connected = false;
  }

  connect() {
    if (this.ws) return;
    this.manualClose = false;
    this._open();
  }

  _open() {
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

  _scheduleReconnect() {
    const d = Math.min(1000 * Math.pow(2, this.attempt), 10000);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualClose) this._open();
    }, d);
  }

  send(type, payload = {}) {
    const msg = JSON.stringify({ type, ...payload });
    if (this.ws && this.ws.readyState === 1) this.ws.send(msg);
    else this.queue.push(msg);
  }

  request(type, payload = {}, timeout = 30000) {
    const reqId = ++this.reqId;
    const full = { ...payload, reqId };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(reqId);
        reject(new Error('请求超时'));
      }, timeout);
      this.waiters.set(reqId, { resolve, reject, timer });
      this.send(type, full);
    });
  }

  _handle(m) {
    if (m.reqId) {
      const w = this.waiters.get(m.reqId);
      if (w) {
        clearTimeout(w.timer);
        this.waiters.delete(m.reqId);
        if (m.error) w.reject(new Error(m.error));
        else w.resolve(m);
        return;
      }
    }
    if (m.type === 'error' && !m.reqId) this.emit('server_error', m);
    const hs = this.handlers.get(m.type);
    if (hs) for (const h of hs) h(m);
  }

  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }
  emit(type, data) {
    const hs = this.handlers.get(type);
    if (hs) for (const h of hs) h(data);
  }

  close() {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
  }
}

export const api = new Api();