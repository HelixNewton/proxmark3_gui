// Command palette.
//
// Everything it lists runs for real: navigation jumps to a page, a client
// command is executed by the client, an action calls the same endpoint the
// corresponding button does. Typing `>` scopes to client commands only, so the
// full 896-command catalogue is reachable without leaving the keyboard.

import { h, fill, debounce } from '../core/dom.js';
import { api } from '../core/api.js';
import { reportError, toast } from '../core/notify.js';
import { showOutput } from './modal.js';

let openInstance = null;

export function isPaletteOpen() { return Boolean(openInstance); }

export function closePalette() {
  openInstance?.close();
}

/**
 * openPalette({ router, actions, initial })
 * `actions` are app-level verbs contributed by main.js (start client, refresh…).
 */
export function openPalette({ router, actions = [], initial = '' }) {
  if (openInstance) { openInstance.focus(); return; }

  let items = [];
  let cursor = 0;

  const input = h('input.palette-input', {
    type: 'text',
    value: initial,
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Search commands, pages and resources',
    'aria-controls': 'palette-list',
    'aria-expanded': 'true',
    role: 'combobox',
    placeholder: 'Search pages, commands and files — prefix with > to run a client command',
  });

  const list = h('div.palette-list#palette-list', { role: 'listbox' });
  const panel = h('div.palette', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' }, [
    h('div.palette-input-row', [h('span.caret', '▸'), input]),
    list,
    h('div.palette-foot', [
      h('span', [h('kbd', '↑↓'), ' navigate']),
      h('span', [h('kbd', '↵'), ' run']),
      h('span', [h('kbd', 'Esc'), ' close']),
      h('span.faint', 'Prefix > to run a client command directly'),
    ]),
  ]);

  const backdrop = h('div.palette-backdrop', {
    onclick: (event) => { if (event.target === backdrop) close(); },
  }, [panel]);

  const previouslyFocused = document.activeElement;

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKeyDown, true);
    openInstance = null;
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
  }

  function renderGroups(groups) {
    items = [];
    const fragment = [];
    for (const group of groups) {
      if (!group.items.length) continue;
      fragment.push(h('div.palette-group-label', group.label));
      for (const item of group.items) {
        const index = items.length;
        items.push(item);
        fragment.push(h('button.palette-item', {
          role: 'option',
          id: `palette-item-${index}`,
          'aria-selected': String(index === cursor),
          onclick: () => run(item),
          onmousemove: () => { if (cursor !== index) { cursor = index; syncSelection(); } },
        }, [
          h('span.p-title', item.title),
          item.subtitle ? h('span.p-sub', item.subtitle) : h('span.p-sub'),
          item.tag ? h('span.badge.p-tag', item.tag) : null,
        ]));
      }
    }
    if (!items.length) {
      fragment.push(h('div.state', [
        h('div.state-title', 'No matches'),
        h('p.state-msg', 'Try a shorter query, or prefix with > to send the text to the client as a command.'),
      ]));
    }
    fill(list, fragment);
    cursor = Math.min(cursor, Math.max(items.length - 1, 0));
    syncSelection();
  }

  function syncSelection() {
    Array.from(list.querySelectorAll('.palette-item')).forEach((node, index) => {
      node.setAttribute('aria-selected', String(index === cursor));
      if (index === cursor) {
        node.scrollIntoView({ block: 'nearest' });
        input.setAttribute('aria-activedescendant', node.id);
      }
    });
  }

  async function run(item) {
    close();
    try {
      if (item.action === 'navigate') {
        router.navigate(item.value);
      } else if (item.action === 'run') {
        await item.value();
      } else if (item.action === 'command') {
        // Prefill the console rather than firing a device command blind: many
        // catalogue entries need arguments.
        router.navigate('/console', { prefill: item.value });
      } else if (item.action === 'exec') {
        const response = await api.exec(item.value, 60);
        toast(response.result.ok ? 'success' : 'error', item.value,
          `Finished in ${response.result.duration}s`);
        await showOutput(item.value, response.result.output);
      } else if (item.action === 'script') {
        router.navigate('/scripts', { select: item.value });
      } else if (item.action === 'file') {
        const parsed = JSON.parse(item.value);
        router.navigate('/files', { root: parsed.root, path: parsed.path });
      } else if (item.action === 'log') {
        router.navigate('/logs', { q: item.value });
      }
    } catch (error) {
      reportError(error, 'Palette action failed');
    }
  }

  function localGroups(query) {
    const lowered = query.toLowerCase();
    const pages = router.routeList
      .filter((route) => !route.hidden)
      .filter((route) => !lowered || route.title.toLowerCase().includes(lowered))
      .map((route) => ({
        title: route.title, subtitle: route.summary, tag: 'page',
        action: 'navigate', value: route.path,
      }));
    const verbs = actions
      .filter((action) => !lowered || action.title.toLowerCase().includes(lowered))
      .map((action) => ({
        title: action.title, subtitle: action.subtitle, tag: 'action',
        action: 'run', value: action.run,
      }));
    return [
      { id: 'pages', label: 'Go to', items: pages },
      { id: 'actions', label: 'Actions', items: verbs },
    ];
  }

  const search = debounce(async (query) => {
    const trimmed = query.trim();

    // "> …" scopes to the client command catalogue and can run it outright.
    if (trimmed.startsWith('>')) {
      const commandQuery = trimmed.slice(1).trim();
      let catalogue = [];
      try {
        const response = await api.commands({ q: commandQuery, limit: 40 });
        catalogue = response.commands.map((command) => ({
          title: command.name,
          subtitle: command.description,
          tag: command.offline ? 'offline ok' : 'needs device',
          action: 'command',
          value: command.name,
        }));
      } catch (error) {
        reportError(error, 'Command search failed');
      }
      const groups = [];
      if (commandQuery) {
        groups.push({
          id: 'exec', label: 'Run now', items: [{
            title: commandQuery,
            subtitle: 'Execute this exact command and show the output',
            tag: 'exec', action: 'exec', value: commandQuery,
          }],
        });
      }
      groups.push({ id: 'catalogue', label: 'Client commands', items: catalogue });
      renderGroups(groups);
      return;
    }

    const groups = localGroups(trimmed);
    if (trimmed.length >= 2) {
      try {
        const response = await api.search(trimmed);
        groups.push(...response.groups.map((group) => ({
          ...group,
          items: group.items.map((item) => ({ ...item, tag: group.id })),
        })));
      } catch (error) {
        // Global search is an enhancement; local navigation must still work.
        console.warn('Global search unavailable', error);
      }
    }
    renderGroups(groups);
  }, 140);

  function onKeyDown(event) {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cursor = items.length ? (cursor + 1) % items.length : 0;
      syncSelection();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      cursor = items.length ? (cursor - 1 + items.length) % items.length : 0;
      syncSelection();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (items[cursor]) run(items[cursor]);
    }
  }

  input.addEventListener('input', () => search(input.value));
  document.addEventListener('keydown', onKeyDown, true);
  document.body.appendChild(backdrop);
  input.focus();
  input.select();
  search(initial);

  openInstance = { close, focus: () => input.focus() };
}
