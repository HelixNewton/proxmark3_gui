// Flash memory — the SPIFFS filesystem on the device.

import { h, fill, leader } from '../core/dom.js';
import { api } from '../core/api.js';
import { store } from '../core/store.js';
import * as fmt from '../core/fmt.js';
import { loading, empty, errorState, offlineState } from '../components/states.js';
import { confirmAction, showOutput } from '../components/modal.js';
import { reportError, toast } from '../core/notify.js';

export function mount({ router }) {
  const view = h('div.view');
  const overviewBody = h('div.panel-body');
  const filesBody = h('div');
  const actionsBody = h('div.panel-body.stack');
  const unsubscribes = [];

  async function loadSpiffs() {
    fill(overviewBody, loading('Reading the device filesystem…'));
    fill(filesBody, loading());
    try {
      const response = await api.memSpiffs();
      if (response.supported === false) {
        fill(overviewBody, h('div.state', [
          h('div.state-title', 'No flash filesystem on this device'),
          h('p.state-msg', response.reason),
          h('p.state-msg.faint', 'Everything else on this page is unavailable as a result — this is a property of the hardware, not a fault.'),
        ]));
        fill(filesBody, h('div'));
        return;
      }
      renderOverview(response.info);
      renderFiles(response.tree);
    } catch (error) {
      if (error.isOffline) {
        const state = offlineState('Flash memory', { connect: () => router.navigate('/hardware') });
        fill(overviewBody, state);
        fill(filesBody, h('div'));
      } else {
        fill(overviewBody, errorState(error, { retry: loadSpiffs }));
        fill(filesBody, h('div'));
      }
    }
  }

  function renderOverview(info) {
    const used = info.used;
    const total = info.total;
    const percent = total ? (used / total) * 100 : null;
    fill(overviewBody, h('div.stack', [
      percent === null
        ? h('p.hint', 'The client did not report a usable/total figure this view could read. The raw output is below.')
        : h('div.meter', [
            h('div.spread', [
              h('span.readout', { style: { fontSize: 'var(--text-xl)' } },
                [fmt.percent(percent, 1)]),
              h('span.mono.muted', { style: { fontSize: 'var(--text-sm)' } },
                `${fmt.bytes(used)} of ${fmt.bytes(total)}`),
            ]),
            h('div.meter-bar', [h('div.meter-fill', {
              style: { width: `${Math.min(percent, 100)}%` },
              dataset: { level: fmt.usageLevel(percent) },
            })]),
          ]),
      info.sections.length
        ? h('div.stack', info.sections.map((section) => h('div.stack-sm', [
            section.name ? h('div.eyebrow', section.name) : null,
            h('div.kv-grid', section.entries.map((entry) => leader(entry.key, entry.value))),
          ])))
        : null,
      h('details', [
        h('summary.eyebrow', { style: { cursor: 'pointer' } }, 'Raw output'),
        h('pre.output', info.raw),
      ]),
    ]));
  }

  function renderFiles(tree) {
    if (!tree.files.length) {
      fill(filesBody, h('div.stack', [
        empty('No files listed',
          'The device filesystem reported no files, or the tree output used a layout this view could not read.'),
        h('details', { style: { padding: '0 var(--s-4) var(--s-4)' } }, [
          h('summary.eyebrow', { style: { cursor: 'pointer' } }, 'Raw tree output'),
          h('pre.output', tree.raw),
        ]),
      ]));
      return;
    }
    fill(filesBody, h('div.table-wrap', h('table.data', [
      h('thead', h('tr', [h('th', 'File'), h('th.num', 'Size'), h('th', '')])),
      h('tbody', tree.files.map((file) => h('tr', [
        h('td.mono', file.name),
        h('td.num', fmt.bytes(file.size)),
        h('td', h('button.btn.is-sm.is-danger', {
          onclick: () => removeFile(file),
        }, 'Remove')),
      ]))),
    ])));
  }

  async function removeFile(file) {
    const confirmed = await confirmAction({
      title: `Remove ${file.name}`,
      message: `Delete \`${file.name}\` from the device flash filesystem?`,
      note: 'The file is erased on the device. There is no undo and no copy is kept on this machine.',
      confirmLabel: 'Remove file',
    });
    if (!confirmed) return;
    try {
      const response = await api.spiffsRemove(file.name, true);
      toast('success', 'File removed', file.name);
      await showOutput(`mem spiffs remove -f ${file.name}`, response.result.output);
      loadSpiffs();
    } catch (error) {
      reportError(error, 'Could not remove the file');
    }
  }

  async function loadActions() {
    fill(actionsBody, loading());
    try {
      const response = await api.memActions();
      fill(actionsBody, [
        h('div.grid-3', response.actions.map((action) => h('div.stack-sm', [
          h('button.btn', {
            class: action.confirm ? 'is-danger' : '',
            style: { width: '100%', justifyContent: 'center' },
            onclick: () => runAction(action),
          }, action.label),
          h('code.mono.faint', { style: { fontSize: 'var(--text-xs)' } }, action.command),
        ]))),
        h('p.hint', 'SPIFFS must be mounted before files can be listed or removed. Checking defragments the filesystem and can take a while.'),
      ]);
    } catch (error) {
      fill(actionsBody, errorState(error, { retry: loadActions }));
    }
  }

  async function runAction(action) {
    if (action.confirm) {
      const confirmed = await confirmAction({
        title: action.label,
        message: `Run \`${action.command}\` on the connected device?`,
        note: action.note,
        confirmLabel: action.label,
      });
      if (!confirmed) return;
    }
    try {
      const response = await api.memAction(action.id, true);
      toast(response.result.ok ? 'success' : 'warning', action.label,
        `Finished in ${response.result.duration}s`);
      await showOutput(action.command, response.result.output);
      loadSpiffs();
    } catch (error) {
      reportError(error, `${action.label} failed`);
    }
  }

  fill(view, [
    h('div.view-head', [
      h('div.titles', [
        h('h1.page-title', 'Flash memory'),
        h('p.lede', 'The SPIFFS filesystem stored on the Proxmark3\'s own flash — dictionaries, dumps and standalone-mode data live here.'),
      ]),
      h('div.view-actions', [
        h('button.btn.is-sm', { onclick: loadSpiffs }, 'Reload'),
      ]),
    ]),
    h('div.grid-2', [
      h('section.panel.is-accent', [
        h('div.panel-head', [h('h2', 'Filesystem usage')]),
        overviewBody,
      ]),
      h('section.panel', [
        h('div.panel-head', [h('h2', 'Filesystem actions')]),
        actionsBody,
      ]),
    ]),
    h('section.panel', [
      h('div.panel-head', [h('h2', 'Files on device')]),
      filesBody,
    ]),
  ]);

  loadActions();
  if (store.get('session').status === 'online') {
    loadSpiffs();
  } else {
    fill(overviewBody, offlineState('Flash memory', { connect: () => router.navigate('/hardware') }));
    fill(filesBody, h('div'));
  }

  unsubscribes.push(store.on('session', (session) => {
    if (session.status === 'online' && !filesBody.childElementCount) loadSpiffs();
  }));

  return [view, () => unsubscribes.forEach((off) => off())];
}
