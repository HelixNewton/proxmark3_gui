// Reconnecting WebSocket wrapper with exponential backoff.
//
// The connection state is published too: a dropped socket is a real condition
// the operator needs to see, not something to hide behind stale data.

import { token } from './api.js';

export class Socket extends EventTarget {
  constructor(path) {
    super();
    this.path = path;
    this.ws = null;
    this.state = 'connecting';
    this.attempt = 0;
    this.closedByUs = false;
    this.queue = [];
  }

  get url() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const suffix = token ? `?token=${encodeURIComponent(token)}` : '';
    return `${scheme}://${location.host}${this.path}${suffix}`;
  }

  connect() {
    this.closedByUs = false;
    this.#setState('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.attempt = 0;
      this.#setState('open');
      this.queue.splice(0).forEach((message) => ws.send(message));
    });

    ws.addEventListener('message', (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      this.dispatchEvent(new CustomEvent('message', { detail: data }));
      if (data.type) {
        this.dispatchEvent(new CustomEvent(data.type, { detail: data }));
      }
    });

    ws.addEventListener('close', () => {
      this.ws = null;
      if (this.closedByUs) {
        this.#setState('closed');
        return;
      }
      this.#setState('closed');
      this.#scheduleReconnect();
    });

    ws.addEventListener('error', () => { /* close handler drives reconnection */ });
  }

  send(payload) {
    const message = JSON.stringify(payload);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    } else if (this.queue.length < 64) {
      this.queue.push(message);
    }
  }

  close() {
    this.closedByUs = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }

  #scheduleReconnect() {
    this.attempt += 1;
    // 0.5s, 1s, 2s, 4s … capped at 10s so a restarting server is picked up fast.
    const delay = Math.min(500 * 2 ** (this.attempt - 1), 10000);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, attempt: this.attempt } }));
  }
}
