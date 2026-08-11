// Application state: one observable object, updated from REST responses and the
// event socket. Views subscribe to the keys they render, so a metrics tick does
// not re-render the log viewer.

const MAX_METRICS = 180;
const MAX_ACTIVITY = 120;

class Store extends EventTarget {
  constructor() {
    super();
    this.state = {
      session: { status: 'stopped', detail: 'Connecting to the GUI server…' },
      host: {},
      catalog: { count: 0, groups: {} },
      paths: {},
      clientBinary: null,
      metrics: [],
      metricsAvailable: true,
      storage: [],
      notifications: [],
      activity: [],
      unread: 0,
      socket: { events: 'connecting', console: 'connecting' },
      railCollapsed: loadBool('pm3gui.rail', false),
      busy: false,
    };
  }

  get(key) { return this.state[key]; }

  /** Merge a patch and notify subscribers of each changed key. */
  patch(partial) {
    const changed = [];
    for (const [key, value] of Object.entries(partial)) {
      if (this.state[key] !== value) {
        this.state[key] = value;
        changed.push(key);
      }
    }
    changed.forEach((key) => {
      this.dispatchEvent(new CustomEvent(`change:${key}`, { detail: this.state[key] }));
    });
    if (changed.length) {
      this.dispatchEvent(new CustomEvent('change', { detail: { keys: changed, state: this.state } }));
    }
  }

  on(key, handler) {
    const listener = (event) => handler(event.detail);
    this.addEventListener(`change:${key}`, listener);
    return () => this.removeEventListener(`change:${key}`, listener);
  }

  pushMetrics(sample) {
    const next = this.state.metrics.concat([sample]).slice(-MAX_METRICS);
    this.patch({ metrics: next, metricsAvailable: sample.available !== false });
  }

  pushActivity(entry) {
    const next = [entry, ...this.state.activity].slice(0, MAX_ACTIVITY);
    this.patch({ activity: next });
  }

  pushNotification(entry) {
    const next = [entry, ...this.state.notifications].slice(0, 100);
    this.patch({ notifications: next, unread: this.state.unread + 1 });
  }

  markRead() { this.patch({ unread: 0 }); }

  setRail(collapsed) {
    saveBool('pm3gui.rail', collapsed);
    this.patch({ railCollapsed: collapsed });
  }

  /** Latest metrics sample, or null when the sampler has not reported yet. */
  get latestMetrics() {
    return this.state.metrics.length ? this.state.metrics[this.state.metrics.length - 1] : null;
  }

  /** Extract one numeric series from the metrics history for charting. */
  series(pick) {
    return this.state.metrics.map((sample) => {
      const value = pick(sample);
      return { ts: sample.ts, value: Number.isFinite(value) ? value : null };
    });
  }
}

function loadBool(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch { return fallback; }
}

function saveBool(key, value) {
  try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* private mode */ }
}

export function loadPref(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

export function savePref(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

export const store = new Store();
