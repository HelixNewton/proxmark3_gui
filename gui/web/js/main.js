// Application shell: rail, topbar, routing, live sockets, keyboard shortcuts.

import { h, fill, $ } from './core/dom.js';
import { api, ApiError } from './core/api.js';
import { Socket } from './core/ws.js';
import { store } from './core/store.js';
import { Router } from './core/router.js';
import { toast, notify, reportError, notificationDrawer } from './core/notify.js';
import * as shortcuts from './core/shortcuts.js';
import * as fmt from './core/fmt.js';
import { icon, brandMark } from './components/icons.js';
import { openPalette, closePalette, isPaletteOpen } from './components/palette.js';
import { openModal } from './components/modal.js';

/* ------------------------------------------------------------------ routes */

const NAV = [
  {
    label: 'Operations',
    items: [
      { path: '/', title: 'Dashboard', icon: 'dashboard', module: './pages/dashboard.js',
        summary: 'Device, client and host state at a glance' },
      { path: '/tags', title: 'Tag scan', icon: 'scan', module: './pages/tags.js',
        summary: 'Identify LF and HF tags with hf/lf search' },
      { path: '/signal', title: 'Signal', icon: 'wave', module: './pages/signal.js',
        summary: 'Graph buffer capture, plotting and demodulation' },
      { path: '/traces', title: 'Traces', icon: 'trace', module: './pages/traces.js',
        summary: 'Load, annotate and save protocol traces' },
    ],
  },
  {
    label: 'Device',
    items: [
      { path: '/hardware', title: 'Hardware', icon: 'antenna', module: './pages/hardware.js',
        summary: 'Client session, firmware, antenna tuning and device actions' },
      { path: '/memory', title: 'Flash memory', icon: 'chip', module: './pages/memory.js',
        summary: 'SPIFFS filesystem on the device flash' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { path: '/console', title: 'Console', icon: 'terminal', module: './pages/console.js',
        summary: 'Full interactive client terminal' },
      { path: '/scripts', title: 'Scripts', icon: 'script', module: './pages/scripts.js',
        summary: 'Run Lua, Cmd and Python scripts' },
      { path: '/commands', title: 'Command reference', icon: 'book', module: './pages/commands.js',
        summary: 'Every client command with usage and options' },
      { path: '/files', title: 'Files', icon: 'files', module: './pages/files.js',
        summary: 'Traces, dumps, dictionaries and resources on disk' },
    ],
  },
  {
    label: 'System',
    items: [
      { path: '/logs', title: 'Logs', icon: 'logs', module: './pages/logs.js',
        summary: 'Live session log with severity filtering' },
      { path: '/config', title: 'Configuration', icon: 'settings', module: './pages/config.js',
        summary: 'Client preferences and GUI settings' },
      { path: '/about', title: 'About', icon: 'info', module: './pages/about.js',
        summary: 'Versions, paths and project information' },
    ],
  },
];

const ALL_ROUTES = NAV.flatMap((group) => group.items);

/* -------------------------------------------------------------------- rail */

function buildRail(router) {
  const nav = h('nav.rail-nav', { 'aria-label': 'Primary' });

  NAV.forEach((group) => {
    nav.appendChild(h('div.rail-section', group.label));
    group.items.forEach((route) => {
      nav.appendChild(h('a.rail-link', {
        href: `#${route.path}`,
        dataset: { path: route.path, label: route.title },
        title: route.summary,
      }, [
        icon(route.icon),
        h('span.label', route.title),
      ]));
    });
  });

  const collapseBtn = h('button.btn.is-ghost.is-sm', {
    onclick: () => store.setRail(!store.get('railCollapsed')),
    'aria-label': 'Toggle sidebar',
    title: 'Toggle sidebar (Ctrl B)',
  }, [icon('rail', { size: 16 }), h('span.foot-text', 'Collapse')]);

  const rail = h('aside.rail', [
    h('a.rail-brand', { href: '#/', 'aria-label': 'PM3 Command Centre home' }, [
      brandMark(),
      h('span.rail-wordmark', [
        h('span.name', 'PROXMARK3'),
        h('span.sub', 'Command centre'),
      ]),
    ]),
    nav,
    h('div.rail-foot', [collapseBtn]),
  ]);

  router.addEventListener('navigate', ({ detail }) => {
    Array.from(nav.querySelectorAll('.rail-link')).forEach((link) => {
      const active = link.dataset.path === detail.path;
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    // On narrow screens the rail overlays content, so close it after a jump.
    if (window.matchMedia('(max-width: 860px)').matches) store.setRail(true);
  });

  return rail;
}

/* ------------------------------------------------------------------ topbar */

function buildTopbar(router) {
  const statusPill = h('span.pill', { dataset: { state: 'starting' } }, [
    h('span.dot'), h('span.pill-text', 'Starting'),
  ]);
  const detail = h('span.muted.mono.truncate', { style: { fontSize: 'var(--text-xs)' } }, '');
  const linkPill = h('span.pill', { dataset: { state: 'connecting' }, title: 'Live event stream' }, [
    h('span.dot'), h('span.pill-text', 'Link'),
  ]);

  const unreadBadge = h('span.badge', { hidden: true, style: { marginLeft: '-0.4rem' } }, '0');

  let drawer = null;
  function toggleDrawer() {
    if (drawer) { drawer.remove(); drawer = null; return; }
    drawer = notificationDrawer(() => { drawer?.remove(); drawer = null; });
    document.body.appendChild(drawer);
    store.markRead();
  }

  const topbar = h('header.topbar', [
    h('button.btn.is-ghost.is-icon', {
      onclick: () => store.setRail(!store.get('railCollapsed')),
      'aria-label': 'Toggle sidebar',
      title: 'Toggle sidebar (Ctrl B)',
    }, [icon('rail', { size: 18 })]),
    h('div.topbar-status', [statusPill, detail]),
    h('div.grow'),
    h('button.topbar-search', {
      onclick: () => openPalette({ router, actions: paletteActions(router) }),
      'aria-label': 'Open command palette',
    }, [
      icon('search', { size: 15 }),
      h('span.search-label', 'Search or run a command'),
      h('kbd', navigator.platform?.includes('Mac') ? '⌘K' : 'Ctrl K'),
    ]),
    linkPill,
    h('button.btn.is-ghost.is-icon', {
      onclick: toggleDrawer,
      'aria-label': 'Notifications',
      title: 'Notifications',
    }, [icon('bell', { size: 18 }), unreadBadge]),
  ]);

  function renderStatus() {
    const session = store.get('session');
    const map = {
      online: ['online', 'Device online'],
      offline: ['offline', 'Client offline'],
      starting: ['starting', 'Starting'],
      stopped: ['stopped', 'Client stopped'],
      error: ['error', 'Error'],
    };
    const [state, label] = map[session.status] || ['idle', session.status];
    if (statusPill.dataset.state !== state) {
      statusPill.classList.add('just-changed');
      setTimeout(() => statusPill.classList.remove('just-changed'), 500);
    }
    statusPill.dataset.state = state;
    fill(statusPill.querySelector('.pill-text'), label);
    detail.textContent = session.detail || '';
    detail.title = session.detail || '';
  }

  store.on('session', renderStatus);
  store.on('socket', () => {
    const state = store.get('socket').events;
    linkPill.dataset.state = state === 'open' ? 'online' : (state === 'connecting' ? 'connecting' : 'error');
    fill(linkPill.querySelector('.pill-text'), state === 'open' ? 'Link' : (state === 'connecting' ? 'Linking' : 'No link'));
  });
  store.on('unread', (count) => {
    unreadBadge.hidden = count === 0;
    fill(unreadBadge, String(count));
  });
  renderStatus();

  return topbar;
}

/* ------------------------------------------------------- palette actions */

function paletteActions(router) {
  return [
    {
      title: 'Start client',
      subtitle: 'Launch the proxmark3 client and auto-detect the device',
      run: async () => {
        try {
          const response = await api.sessionStart(null, true);
          store.patch({ session: response.session });
          toast('success', 'Client started', response.session.detail);
        } catch (error) { reportError(error, 'Could not start the client'); }
      },
    },
    {
      title: 'Restart client',
      subtitle: 'Stop and relaunch the client session',
      run: async () => {
        try {
          const response = await api.sessionRestart(null, true);
          store.patch({ session: response.session });
          toast('success', 'Client restarted', response.session.detail);
        } catch (error) { reportError(error, 'Could not restart the client'); }
      },
    },
    {
      title: 'Stop client',
      subtitle: 'Terminate the proxmark3 client session',
      run: async () => {
        try {
          const response = await api.sessionStop();
          store.patch({ session: response.session });
          toast('info', 'Client stopped', 'No commands can run until it is started again.');
        } catch (error) { reportError(error, 'Could not stop the client'); }
      },
    },
    {
      title: 'Abort running command',
      subtitle: 'Ask the client to stop the command it is running',
      run: async () => {
        try {
          await api.sessionInterrupt();
          toast('info', 'Abort sent', 'The client was asked to stop the running command.');
        } catch (error) { reportError(error, 'Could not send the interrupt'); }
      },
    },
    {
      title: 'Refresh current page',
      subtitle: 'Reload the data on this page',
      run: () => router.resolve(),
    },
    {
      title: 'Show keyboard shortcuts',
      subtitle: 'List every shortcut this interface supports',
      run: () => showShortcutSheet(),
    },
  ];
}

function showShortcutSheet() {
  const bindings = shortcuts.list();
  return openModal({
    title: 'Keyboard shortcuts',
    body: h('div.stack-sm', bindings.map((binding) => h('div.leader', [
      h('span.leader-key', binding.description),
      h('span.leader-fill'),
      h('span.leader-value', h('kbd', shortcuts.chord(binding))),
    ]))),
    actions: [{ label: 'Close', primary: true, run: (close) => close(null) }],
  });
}

/* ------------------------------------------------------------ live sockets */

function connectSockets(router) {
  const events = new Socket('/ws/events');

  events.addEventListener('state', ({ detail }) => {
    store.patch({ socket: { ...store.get('socket'), events: detail.state } });
    if (detail.state === 'closed' && detail.attempt === 1) {
      toast('warning', 'Live link lost', 'Reconnecting to the GUI server…');
    }
  });

  events.addEventListener('hello', ({ detail }) => {
    store.patch({ session: detail.session });
    if (detail.metrics) store.pushMetrics(detail.metrics);
    if (detail.notifications?.length) {
      store.patch({ notifications: detail.notifications.slice().reverse() });
    }
  });

  events.addEventListener('metrics', ({ detail }) => store.pushMetrics(detail.sample));

  events.addEventListener('session', ({ detail }) => {
    const previous = store.get('session');
    store.patch({ session: detail.state });
    if (previous.status !== detail.state.status) {
      store.pushActivity({
        kind: 'session', level: detail.state.status === 'online' ? 'success' : 'info',
        title: `Client ${detail.state.status}`, message: detail.state.detail,
        ts: Date.now() / 1000,
      });
    }
  });

  events.addEventListener('notification', ({ detail }) => {
    store.pushNotification(detail);
    toast(detail.level, detail.title, detail.message, detail.link
      ? { action: { label: 'Open', run: () => { location.hash = detail.link; } } }
      : {});
  });

  events.addEventListener('command.start', ({ detail }) => {
    store.patch({ busy: true });
    store.pushActivity({ kind: 'command', level: 'info', title: detail.command,
      message: 'started', ts: detail.ts });
  });

  events.addEventListener('command.end', ({ detail }) => {
    store.patch({ busy: false });
    store.pushActivity({
      kind: 'command',
      level: detail.level === 'error' || detail.level === 'critical' ? 'error' : 'success',
      title: detail.command,
      message: `${detail.timedOut ? 'timed out after' : 'finished in'} ${detail.duration}s`,
      ts: detail.ts,
    });
  });

  events.connect();
  return events;
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  const outlet = h('main.main#view-outlet', { tabindex: '-1', role: 'main' });
  const router = new Router(outlet);

  ALL_ROUTES.forEach((route) => {
    router.register(route.path, {
      title: route.title,
      summary: route.summary,
      icon: route.icon,
      mount: async (context) => {
        const module = await import(route.module);
        return module.mount(context);
      },
    });
  });

  const shell = h('div.shell#shell', [buildRail(router), buildTopbar(router), outlet]);
  document.body.appendChild(shell);

  const applyRail = () => {
    shell.dataset.rail = store.get('railCollapsed') ? 'collapsed' : 'expanded';
  };
  store.on('railCollapsed', applyRail);
  applyRail();
  store.on('busy', (busy) => { shell.dataset.busy = String(busy); });

  // --- shortcuts ---------------------------------------------------------
  shortcuts.install();
  shortcuts.register({
    key: 'k', mod: true, description: 'Open the command palette',
    run: () => (isPaletteOpen() ? closePalette() : openPalette({ router, actions: paletteActions(router) })),
  });
  shortcuts.register({
    key: '/', mod: true, description: 'Search everything',
    run: () => openPalette({ router, actions: paletteActions(router) }),
  });
  shortcuts.register({
    key: 'b', mod: true, description: 'Toggle the sidebar',
    run: () => store.setRail(!store.get('railCollapsed')),
  });
  shortcuts.register({
    key: 'r', description: 'Refresh the current page', whenTyping: false,
    run: () => router.resolve(),
  });
  shortcuts.register({
    key: '?', shift: true, description: 'Show this shortcut list', whenTyping: false,
    run: () => showShortcutSheet(),
  });
  shortcuts.register({
    key: 'Escape', description: 'Close the palette, a dialog or the notification drawer',
    run: () => {
      closePalette();
      document.querySelector('dialog.modal[open]')?.close();
      document.querySelector('.drawer')?.remove();
    },
  });
  ['1', '2', '3', '4', '5', '6', '7', '8', '9'].forEach((digit, index) => {
    if (!ALL_ROUTES[index]) return;
    shortcuts.register({
      key: digit, mod: true,
      description: index < 4 ? `Go to ${ALL_ROUTES[index].title}` : null,
      run: () => router.navigate(ALL_ROUTES[index].path),
    });
  });

  connectSockets(router);

  // --- first paint -------------------------------------------------------
  try {
    const status = await api.status();
    store.patch({
      session: status.session,
      host: status.host,
      catalog: status.catalog,
      paths: status.paths,
      clientBinary: status.clientBinary,
      notifications: (status.notifications || []).slice().reverse(),
    });
    if (status.catalog?.error) {
      toast('warning', 'Command catalogue unavailable', status.catalog.error);
    }
  } catch (error) {
    store.patch({ session: { status: 'error', detail: error.message } });
    toast('error', 'Cannot reach the GUI server', error.message, { duration: 0 });
  }

  // Metrics history so charts have shape immediately rather than filling in
  // one sample at a time.
  api.metrics()
    .then((response) => {
      store.patch({
        metrics: response.history || [],
        metricsAvailable: response.available,
        storage: response.storage || [],
      });
    })
    .catch(() => store.patch({ metricsAvailable: false }));

  router.resolve();
  window.__pm3 = { store, api, router };
}

document.addEventListener('DOMContentLoaded', boot);
