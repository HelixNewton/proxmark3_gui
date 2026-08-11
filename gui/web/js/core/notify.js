// Toasts and the notification centre.
//
// Toasts auto-dismiss except for errors, which stay until dismissed — a failed
// device command is not something to let scroll away on a timer.

import { h, fill } from './dom.js';
import { store } from './store.js';

const AUTO_DISMISS = { success: 4000, info: 5000, warning: 8000, error: 0, critical: 0 };

let deck = null;

function ensureDeck() {
  if (!deck) {
    deck = h('div.toast-deck', {
      role: 'status',
      'aria-live': 'polite',
      'aria-relevant': 'additions',
    });
    document.body.appendChild(deck);
  }
  return deck;
}

/**
 * toast('error', 'Command failed', 'hw tune needs a device', { action })
 * `action` renders a button, e.g. Retry or "Open logs".
 */
export function toast(level, title, message = '', options = {}) {
  const node = h('div.toast', { dataset: { level }, role: level === 'error' ? 'alert' : null }, [
    h('div.grow.stack-sm', [
      h('div.toast-title', title),
      message ? h('div.toast-msg', message) : null,
      options.action
        ? h('div', { style: { marginTop: '0.25rem' } }, [
            h('button.btn.is-sm', {
              onclick: () => { dismiss(); options.action.run(); },
            }, options.action.label),
          ])
        : null,
    ]),
    h('button.btn.is-ghost.is-sm', {
      onclick: () => dismiss(),
      'aria-label': 'Dismiss notification',
    }, '✕'),
  ]);

  let timer = null;
  function dismiss() {
    clearTimeout(timer);
    node.classList.add('is-leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 400);
  }

  ensureDeck().appendChild(node);
  const delay = options.duration ?? AUTO_DISMISS[level] ?? 5000;
  if (delay > 0) timer = setTimeout(dismiss, delay);

  // Keep a hovered toast on screen while it is being read.
  node.addEventListener('mouseenter', () => clearTimeout(timer));
  node.addEventListener('mouseleave', () => {
    if (delay > 0) timer = setTimeout(dismiss, 2000);
  });

  return dismiss;
}

/** Record a notification in the centre *and* surface it as a toast. */
export function notify(level, title, message = '', options = {}) {
  const entry = { level, title, message, ts: Date.now() / 1000, link: options.link || null };
  store.pushNotification(entry);
  store.pushActivity({ ...entry, kind: 'notification' });
  toast(level, title, message, options);
  return entry;
}

/** Translate an ApiError into the clearest message we can give the operator. */
export function reportError(error, context = '') {
  const title = context || 'Request failed';
  if (error?.isOffline) {
    toast('warning', title, `${error.message}`);
  } else if (error?.isBusy) {
    toast('warning', title, 'The client is still running another command. Try again in a moment.');
  } else if (error?.isUnavailable) {
    toast('error', title, error.message, {
      action: { label: 'Open Hardware', run: () => { location.hash = '#/hardware'; } },
    });
  } else {
    toast('error', title, error?.message || String(error));
  }
}

/** Notification centre drawer, toggled from the topbar bell. */
export function notificationDrawer(onClose) {
  const list = h('div.drawer-list');
  const drawer = h('aside.drawer', { role: 'dialog', 'aria-label': 'Notification centre' }, [
    h('div.panel-head', [
      h('h2', 'Notifications'),
      h('div.row', [
        h('button.btn.is-ghost.is-sm', {
          onclick: () => {
            store.patch({ notifications: [] });
            render();
          },
        }, 'Clear'),
        h('button.btn.is-ghost.is-sm', { onclick: onClose, 'aria-label': 'Close notifications' }, '✕'),
      ]),
    ]),
    list,
  ]);

  function render() {
    const items = store.get('notifications');
    if (!items.length) {
      fill(list, h('div.state', [
        h('div.state-title', 'Nothing to report'),
        h('p.state-msg', 'Device events, command results and configuration changes appear here.'),
      ]));
      return;
    }
    fill(list, items.map((entry) => h('button.drawer-item', {
      dataset: { level: entry.level },
      onclick: () => {
        if (entry.link) location.hash = entry.link;
        onClose();
      },
    }, [
      h('div.spread', [
        h('span.mono', { style: { fontSize: 'var(--text-sm)' } }, entry.title),
        h('span.faint.mono', { style: { fontSize: 'var(--text-xs)' } },
          new Date(entry.ts * 1000).toLocaleTimeString(undefined, { hour12: false })),
      ]),
      entry.message ? h('div.muted', { style: { fontSize: 'var(--text-xs)' } }, entry.message) : null,
    ])));
  }

  render();
  store.on('notifications', render);
  return drawer;
}
