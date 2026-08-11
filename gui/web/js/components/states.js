// Loading / empty / error / offline states.
//
// Every asynchronous surface uses these, so the operator never faces a blank
// panel and always learns what to do next.

import { h } from '../core/dom.js';
import { icon } from './icons.js';

export function loading(message = 'Reading from the client…') {
  return h('div.state', { role: 'status', 'aria-live': 'polite' }, [
    h('div.sweep', { 'aria-hidden': 'true' }),
    h('p.state-msg', message),
  ]);
}

export function empty(title, message, action = null) {
  return h('div.state', [
    h('div.state-title', title),
    message ? h('p.state-msg', message) : null,
    action ? h('button.btn', { onclick: action.run }, action.label) : null,
  ]);
}

/**
 * A failure the operator can act on: what broke, the server's own words, and a
 * retry. Never swallows the underlying message.
 */
export function errorState(error, { retry = null, title = 'Could not load this' } = {}) {
  const message = error?.message || String(error || 'Unknown error');
  const hint = error?.payload?.hint;
  return h('div.state.is-error', { role: 'alert' }, [
    icon('info', { size: 22 }),
    h('div.state-title', title),
    h('p.state-msg', message),
    hint ? h('p.state-msg.faint', hint) : null,
    retry ? h('button.btn.is-primary', { onclick: retry }, 'Try again') : null,
  ]);
}

/** The client is running but no Proxmark3 is attached. */
export function offlineState(what, { connect = null } = {}) {
  return h('div.state.is-offline', [
    icon('plug', { size: 22 }),
    h('div.state-title', 'No device connected'),
    h('p.state-msg', `${what} reads live data from a Proxmark3. Connect the device over USB, then attach the client to its serial port.`),
    connect ? h('button.btn.is-primary', { onclick: connect }, 'Choose a port') : null,
  ]);
}

/** The proxmark3 client process itself is not running. */
export function notRunningState({ start = null, binary = null } = {}) {
  return h('div.state.is-error', [
    icon('power', { size: 22 }),
    h('div.state-title', 'Client not running'),
    h('p.state-msg', binary
      ? 'The proxmark3 client is not running, so no commands can be executed.'
      : 'The proxmark3 client binary was not found. Build it with `make client` in the repository root, then start the session.'),
    start ? h('button.btn.is-primary', { onclick: start }, 'Start client') : null,
  ]);
}

/** Skeleton rows for tables and lists while their first response is in flight. */
export function skeletonRows(count = 5, height = '1.1rem') {
  return h('div.stack-sm', { 'aria-hidden': 'true', style: { padding: 'var(--s-4)' } },
    Array.from({ length: count }, (_, i) => h('div.skeleton', {
      style: { height, width: `${100 - (i % 3) * 12}%` },
    })));
}

/**
 * Render an async section: shows loading, then either the view or a typed error
 * state. `render` receives the resolved payload.
 */
export async function asyncSection(target, load, render, options = {}) {
  target.replaceChildren(loading(options.loadingMessage));
  try {
    const data = await load();
    const view = await render(data);
    target.replaceChildren(view);
    return data;
  } catch (error) {
    const retry = () => asyncSection(target, load, render, options);
    if (error?.isOffline && options.offlineFor) {
      target.replaceChildren(offlineState(options.offlineFor, { connect: options.onConnect }));
    } else if (error?.isUnavailable) {
      target.replaceChildren(notRunningState({ start: options.onStart, binary: options.binary }));
    } else {
      target.replaceChildren(errorState(error, { retry, title: options.errorTitle }));
    }
    return null;
  }
}
