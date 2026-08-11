// Command reference — the whole client command set, searchable.
//
// Sourced from doc/commands.json, which the client build generates from its own
// help output, so this page cannot drift from the binary.

import { h, fill, debounce, copyText } from '../core/dom.js';
import { api } from '../core/api.js';
import { store } from '../core/store.js';
import { loading, empty, errorState } from '../components/states.js';
import { showOutput } from '../components/modal.js';
import { toast, reportError } from '../core/notify.js';

export function mount({ router, params }) {
  const view = h('div.view');
  const listBody = h('div.list-scroll');
  const detailBody = h('div.panel-body');
  const groupRow = h('div.cmd-groups');
  const searchInput = h('input.input', {
    type: 'search',
    placeholder: 'Search 896 commands…',
    'aria-label': 'Search commands',
    value: params.get('q') || '',
  });
  const summary = h('span.eyebrow');

  let activeGroup = params.get('group') || '';

  async function loadGroups() {
    const catalog = store.get('catalog');
    const groups = catalog.groups || {};
    fill(groupRow, [
      h('button.btn.is-sm', {
        class: activeGroup ? '' : 'is-on',
        onclick: () => { activeGroup = ''; loadGroups(); search(); },
      }, `All (${catalog.count})`),
      ...Object.entries(groups).map(([group, count]) => h('button.btn.is-sm', {
        class: group === activeGroup ? 'is-on' : '',
        onclick: () => { activeGroup = group; loadGroups(); search(); },
      }, `${group} ${count}`)),
    ]);
  }

  async function loadList() {
    fill(listBody, loading('Reading the command catalogue…'));
    try {
      const response = await api.commands({
        q: searchInput.value.trim(),
        group: activeGroup || undefined,
        limit: 300,
      });
      fill(summary, response.commands.length >= 300
        ? `first 300 of ${response.total} — refine the search`
        : `${response.commands.length} of ${response.total} commands`);
      if (!response.commands.length) {
        fill(listBody, empty('No commands match',
          'Try a shorter query, or clear the group filter.'));
        return;
      }
      fill(listBody, h('div.table-wrap', h('table.data', [
        h('thead', h('tr', [h('th', 'Command'), h('th', 'Description'), h('th', 'Offline')])),
        h('tbody', response.commands.map((command) => h('tr.is-clickable', {
          onclick: () => showDetail(command.name),
        }, [
          h('td.mono.cmd-name', command.name),
          h('td', h('div.cmd-desc', command.description || '')),
          h('td', command.offline
            ? h('span.badge.is-ok', 'yes')
            : h('span.badge.is-warn', 'device')),
        ]))),
      ])));
    } catch (error) {
      fill(listBody, errorState(error, { retry: loadList }));
    }
  }

  async function showDetail(name) {
    fill(detailBody, loading());
    try {
      const response = await api.commandDetail(name);
      const command = response.command;
      fill(detailBody, h('div.stack.cmd-detail', [
        h('div.spread', [
          h('h3.mono', { style: { fontSize: 'var(--text-md)', color: 'var(--ink-strong)' } }, command.name),
          command.offline
            ? h('span.badge.is-ok', 'works offline')
            : h('span.badge.is-warn', 'needs a device'),
        ]),
        command.description ? h('p.muted', command.description) : null,
        command.usage ? h('div.stack-sm', [
          h('div.eyebrow', 'Usage'),
          h('code.cmd-usage', command.usage),
        ]) : null,
        response.options.length ? h('div.stack-sm', [
          h('div.eyebrow', 'Options'),
          ...response.options.map((option) => h('div.option-row', [
            h('span.flags', option.flags || '—'),
            h('span.desc', option.description),
          ])),
        ]) : null,
        command.notes.length ? h('div.stack-sm', [
          h('div.eyebrow', 'Examples'),
          ...command.notes.map((note) => h('code.cmd-usage', note)),
        ]) : null,
        h('div.row-wrap', [
          h('button.btn.is-primary', {
            onclick: () => router.navigate('/console', { prefill: command.name }),
          }, 'Open in console'),
          h('button.btn', {
            onclick: async () => {
              try {
                const result = await api.exec(command.name, 60);
                await showOutput(command.name, result.result.output);
              } catch (error) { reportError(error, `${command.name} failed`); }
            },
            title: command.offline
              ? 'Runs the command with no arguments'
              : 'Runs the command with no arguments — needs a connected device',
          }, 'Run as-is'),
          h('button.btn.is-ghost', {
            onclick: async () => {
              const okay = await copyText(command.usage || command.name);
              toast(okay ? 'success' : 'error', okay ? 'Usage copied' : 'Copy failed');
            },
          }, 'Copy usage'),
        ]),
        h('p.hint', 'Running a command with no arguments is safe for informational commands but will fail for anything that requires parameters — the client reports what is missing.'),
      ]));
    } catch (error) {
      fill(detailBody, errorState(error, { retry: () => showDetail(name) }));
    }
  }

  const search = debounce(loadList, 180);
  searchInput.addEventListener('input', search);

  fill(view, [
    h('div.view-head', [
      h('div.titles', [
        h('h1.page-title', 'Command reference'),
        h('p.lede', 'Every command the client exposes, with its usage, options and examples — generated from the client\'s own help output during the build.'),
      ]),
      h('div.view-actions', [summary]),
    ]),
    h('section.panel', [
      h('div.panel-body.stack-sm', [searchInput, groupRow]),
    ]),
    h('div.grid-split', { style: { gridTemplateColumns: 'minmax(0, 1.35fr) minmax(0, 1fr)' } }, [
      h('section.panel', [h('div.panel-head', [h('h2', 'Commands')]), listBody]),
      h('section.panel', [h('div.panel-head', [h('h2', 'Detail')]), detailBody]),
    ]),
  ]);

  fill(detailBody, empty('No command selected',
    'Pick a command to see its usage, flags and examples.'));
  loadGroups();
  loadList();
  const preselect = params.get('name');
  if (preselect) showDetail(preselect);

  return view;
}
