// HTTP client for the PM3 command centre API.
//
// Every failure is surfaced as an ApiError carrying the server's own message and
// status, so views can render a real explanation instead of a generic "failed".

const TOKEN_KEY = 'pm3gui.token';

/** Token arrives in the URL when the server is not bound to loopback. */
function readToken() {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    try { sessionStorage.setItem(TOKEN_KEY, fromUrl); } catch { /* private mode */ }
    return fromUrl;
  }
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export const token = readToken();

export class ApiError extends Error {
  constructor(message, { status = 0, reason = null, payload = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.reason = reason;
    this.payload = payload || {};
  }

  /** True when the action needs a connected Proxmark3 that is not attached. */
  get isOffline() { return this.reason === 'offline' || this.status === 409; }
  get isBusy() { return this.reason === 'busy'; }
  get needsConfirm() { return this.status === 428; }
  get isUnavailable() { return this.status === 503; }
}

async function request(path, { method = 'GET', body, signal, timeout = 0 } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers['X-PM3-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = timeout ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal || controller?.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new ApiError('The request timed out before the server responded.', { status: 0 });
    }
    throw new ApiError('Cannot reach the GUI server. Is it still running?', { status: 0 });
  } finally {
    if (timer) clearTimeout(timer);
  }

  let payload = null;
  const type = response.headers.get('Content-Type') || '';
  if (type.includes('application/json')) {
    try { payload = await response.json(); } catch { payload = null; }
  }

  if (!response.ok || (payload && payload.ok === false)) {
    const message = payload?.error || `${response.status} ${response.statusText}`;
    throw new ApiError(message, {
      status: response.status,
      reason: payload?.reason || null,
      payload: payload || {},
    });
  }
  return payload ?? {};
}

const get = (path, opts) => request(path, opts);
const post = (path, body, opts) => request(path, { method: 'POST', body, ...opts });

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== null && value !== undefined && value !== '') search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** Build a download URL, carrying the token when one is in force. */
export function downloadUrl(root, path) {
  return `/api/files/download${query({ root, path, token: token || undefined })}`;
}

export const api = {
  status: () => get('/api/status'),
  devices: () => get('/api/devices'),

  sessionStart: (port, auto = true) => post('/api/session/start', { port, auto }),
  sessionStop: () => post('/api/session/stop', {}),
  sessionRestart: (port, auto = true) => post('/api/session/restart', { port, auto }),
  sessionInterrupt: () => post('/api/session/interrupt', {}),
  connect: (port) => post('/api/session/connect', { port }),

  exec: (command, timeout = 30) => post('/api/exec', { command, timeout }),
  commands: (params) => get(`/api/commands${query(params)}`),
  commandDetail: (name) => get(`/api/commands/detail${query({ name })}`),
  complete: (q) => get(`/api/complete${query({ q })}`),

  hwVersion: () => get('/api/hw/version'),
  hwStatus: () => get('/api/hw/status'),
  hwTune: () => get('/api/hw/tune'),
  hwActions: () => get('/api/hw/actions'),
  hwAction: (action, confirm = false) => post('/api/hw/action', { action, confirm }),
  hwDbg: (level) => post('/api/hw/dbg', { level }),

  memSpiffs: () => get('/api/mem/spiffs'),
  memActions: () => get('/api/mem/actions'),
  memAction: (action, confirm = false) => post('/api/mem/action', { action, confirm }),
  spiffsRemove: (name, confirm = false) => post('/api/mem/spiffs/remove', { name, confirm }),

  signalOps: () => get('/api/signal/ops'),
  signalBuffer: (points = 1200) => get(`/api/signal/buffer${query({ points })}`),
  signalCapture: (samples, points) => post('/api/signal/capture', { samples, points }),
  signalLoad: (root, path, points) => post('/api/signal/load', { root, path, points }),
  signalOp: (op, points) => post('/api/signal/op', { op, points }),

  scanModes: () => get('/api/scan/modes'),
  scanHistory: () => get('/api/scan/history'),
  scan: (mode) => post('/api/scan', { mode }),

  traceProtocols: () => get('/api/trace/protocols'),
  traceList: (options) => post('/api/trace/list', options),
  traceLoad: (root, path) => post('/api/trace/load', { root, path }),
  traceSave: (name) => post('/api/trace/save', { name }),

  scripts: (refresh = false) => get(`/api/scripts${refresh ? '?refresh=1' : ''}`),
  runScript: (name, args, timeout) => post('/api/scripts/run', { name, args, timeout }),

  fileRoots: () => get('/api/files/roots'),
  fileList: (root, path, q) => get(`/api/files/list${query({ root, path, q })}`),
  fileRead: (root, path) => get(`/api/files/read${query({ root, path })}`),
  fileDelete: (root, path) =>
    request(`/api/files${query({ root, path, confirm: '1' })}`, { method: 'DELETE' }),

  logFiles: () => get('/api/logs/files'),
  logs: (params) => get(`/api/logs${query(params)}`),

  prefs: () => get('/api/prefs'),
  setPref: (key, value) => post('/api/prefs/set', { key, value }),

  metrics: () => get('/api/metrics'),
  notifications: () => get('/api/notifications'),
  clearNotifications: () => post('/api/notifications/clear', {}),
  search: (q) => get(`/api/search${query({ q })}`),
};
