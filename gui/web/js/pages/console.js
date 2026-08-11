// Console — the full interactive client terminal.
//
// This is the same session the rest of the interface drives, so a command fired
// from a dashboard button appears here too. Typing goes straight into the
// client's own stdin over the PTY, which means every client feature works,
// including the ones no page wraps.

import { h, fill } from '../core/dom.js';
import { api } from '../core/api.js';
import { Socket } from '../core/ws.js';
import { store } from '../core/store.js';
import { createTerminal } from '../components/terminal.js';
import { toast, reportError } from '../core/notify.js';
import { icon } from '../components/icons.js';

export function mount({ params, router }) {
  const view = h('div.view');
  const statusLine = h('span.muted.mono', { style: { fontSize: 'var(--text-xs)' } }, 'Connecting…');
  const unsubscribes = [];

  const terminal = createTerminal({
    onInput: (text) => socket.send({ type: 'input', data: `${text}\n` }),
    onInterrupt: () => socket.send({ type: 'interrupt' }),
    complete: async (partial) => {
      try {
        const response = await api.complete(partial);
        return response.suggestions;
      } catch {
        return [];
      }
    },
  });

  const socket = new Socket('/ws/console');

  socket.addEventListener('state', ({ detail }) => {
    const labels = {
      open: 'Attached to the client stream',
      connecting: 'Attaching to the client stream…',
      closed: 'Stream lost — reconnecting…',
    };
    statusLine.textContent = labels[detail.state] || detail.state;
    store.patch({ socket: { ...store.get('socket'), console: detail.state } });
  });

  socket.addEventListener('hello', ({ detail }) => {
    terminal.clear();
    if (detail.scrollback) terminal.write(detail.scrollback);
    store.patch({ session: detail.session });
    terminal.setEnabled(detail.session.running);
    // A prefilled command from the palette lands in the input, not executed —
    // most catalogue entries need arguments before they should run.
    const prefill = params.get('prefill');
    if (prefill) {
      const input = view.querySelector('.term-input');
      if (input) { input.value = `${prefill} `; input.focus(); }
    } else {
      terminal.focus();
    }
  });

  socket.addEventListener('output', ({ detail }) => terminal.write(detail.data));
  socket.addEventListener('error', ({ detail }) => toast('error', 'Console', detail.error));

  unsubscribes.push(store.on('session', (session) => terminal.setEnabled(session.running)));

  const sizeTerminal = () => {
    const screen = view.querySelector('.term-screen');
    if (!screen) return;
    // Report the visible grid so the client wraps its tables to the real width.
    const cols = Math.max(60, Math.floor(screen.clientWidth / 7.3));
    const rows = Math.max(10, Math.floor(screen.clientHeight / 19));
    socket.send({ type: 'resize', cols, rows });
  };
  const resizeObserver = new ResizeObserver(sizeTerminal);

  fill(view, [
    h('div.view-head', [
      h('div.titles', [
        h('h1.page-title', 'Console'),
        h('p.lede', 'The live client terminal. Everything the interface runs shows up here.'),
      ]),
      h('div.view-actions', [
        statusLine,
        h('button.btn.is-sm', {
          onclick: async () => {
            try {
              await api.sessionInterrupt();
              toast('info', 'Abort sent', 'The client aborts long-running commands on Enter.');
            } catch (error) { reportError(error, 'Interrupt failed'); }
          },
        }, 'Abort command'),
        h('button.btn.is-sm', {
          onclick: () => router.navigate('/commands'),
        }, [icon('book', { size: 14 }), 'Command reference']),
      ]),
    ]),
    h('section.panel', { style: { display: 'flex', flexDirection: 'column', minHeight: '0' } }, [
      h('div.panel-body.is-flush', { style: { display: 'flex', minHeight: '0' } }, terminal.node),
    ]),
    h('p.hint', 'Tab completes command names from the client catalogue, ↑ and ↓ walk your history. Abort sends Enter, which is how the client cancels a running command — Ctrl+C would terminate the client itself.'),
  ]);

  // Give the terminal a workable height inside the scrolling view.
  const screen = view.querySelector('.term-screen');
  if (screen) screen.style.height = 'calc(100vh - 20rem)';

  socket.connect();
  requestAnimationFrame(() => {
    if (screen) resizeObserver.observe(screen);
    sizeTerminal();
  });

  return [view, () => {
    resizeObserver.disconnect();
    socket.close();
    unsubscribes.forEach((off) => off());
  }];
}
