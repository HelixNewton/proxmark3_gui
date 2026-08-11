// Tag scan — identify a card with the client's own search commands.

import { h, fill, leader, copyText } from '../core/dom.js';
import { api } from '../core/api.js';
import { store } from '../core/store.js';
import * as fmt from '../core/fmt.js';
import { loading, empty, errorState, offlineState } from '../components/states.js';
import { showOutput } from '../components/modal.js';
import { reportError, toast } from '../core/notify.js';

export function mount({ router }) {
  const view = h('div.view');
  const resultBody = h('div.panel-body');
  const historyBody = h('div');
  const unsubscribes = [];
  let scanning = false;

  const modeButtons = h('div.row-wrap');

  async function loadModes() {
    try {
      const response = await api.scanModes();
      fill(modeButtons, response.modes.map((mode) => h('button.btn.is-primary', {
        dataset: { mode: mode.id },
        onclick: () => runScan(mode),
        title: `Runs \`${mode.command}\``,
      }, mode.label)));
      syncEnabled();
    } catch (error) {
      fill(modeButtons, errorState(error, { retry: loadModes }));
    }
  }

  function syncEnabled() {
    const online = store.get('session').status === 'online';
    Array.from(modeButtons.querySelectorAll('button')).forEach((button) => {
      button.disabled = scanning || !online;
      button.title = online
        ? button.title
        : 'A Proxmark3 must be connected to read a tag';
    });
  }

  async function runScan(mode) {
    scanning = true;
    syncEnabled();
    fill(resultBody, loading(`Running \`${mode.command}\` — hold the tag against the antenna…`));
    try {
      const response = await api.scan(mode.id);
      renderScan(response.scan);
      loadHistory();
    } catch (error) {
      if (error.isOffline) fill(resultBody, offlineState('Tag scanning', { connect: () => router.navigate('/hardware') }));
      else fill(resultBody, errorState(error, { retry: () => runScan(mode), title: 'Scan failed' }));
    } finally {
      scanning = false;
      syncEnabled();
    }
  }

  function renderScan(scan) {
    fill(resultBody, h('div.stack', [
      h('div.tag-head', [
        h('span.pill', { dataset: { state: scan.found ? 'success' : 'idle' } },
          [h('span.dot'), scan.found ? 'Tag identified' : 'No known tag found']),
        h('span.faint.mono', { style: { fontSize: 'var(--text-xs)' } },
          `${scan.command} · ${fmt.millis(scan.duration)} · ${fmt.dateTime(scan.ts)}`),
      ]),
      scan.identifiers.length
        ? h('div.stack-sm', [
            h('div.eyebrow', 'Identifiers'),
            h('div.kv-grid', scan.identifiers.map((item) => leader(item.key, item.value))),
          ])
        : null,
      scan.findings.length
        ? h('div.stack-sm', [
            h('div.eyebrow', 'What the client reported'),
            ...scan.findings.map((finding) => h('div.finding', finding.text)),
          ])
        : (scan.found ? null : h('p.hint', 'The client did not recognise a tag. Check the antenna is the right one for the card, and that the card is flat on the antenna.')),
      h('div.row-wrap', [
        h('button.btn.is-sm', { onclick: () => showOutput(scan.command, scan.raw) }, 'View raw output'),
        h('button.btn.is-sm', {
          onclick: async () => {
            const okay = await copyText(scan.raw);
            toast(okay ? 'success' : 'error', okay ? 'Output copied' : 'Copy failed');
          },
        }, 'Copy output'),
        scan.mode === 'lf'
          ? h('button.btn.is-sm', { onclick: () => router.navigate('/signal') }, 'Open the signal it captured')
          : null,
      ]),
    ]));
  }

  async function loadHistory() {
    fill(historyBody, loading());
    try {
      const response = await api.scanHistory();
      if (!response.scans.length) {
        fill(historyBody, empty('No scans in this session',
          'Scan history is kept in memory by the GUI server and resets when it restarts.'));
        return;
      }
      fill(historyBody, h('div.table-wrap', h('table.data', [
        h('thead', h('tr', [
          h('th', 'When'), h('th', 'Command'), h('th', 'Result'), h('th', 'Duration'), h('th', ''),
        ])),
        h('tbody', response.scans.map((scan) => h('tr.is-clickable', {
          onclick: () => renderScan(scan),
        }, [
          h('td', fmt.ago(scan.ts)),
          h('td.mono', scan.command),
          h('td', scan.found
            ? h('span.badge.is-ok', 'identified')
            : h('span.badge', 'nothing found')),
          h('td.num', fmt.millis(scan.duration)),
          h('td', h('button.btn.is-sm.is-ghost', {
            onclick: (event) => { event.stopPropagation(); showOutput(scan.command, scan.raw); },
          }, 'Raw')),
        ]))),
      ])));
    } catch (error) {
      fill(historyBody, errorState(error, { retry: loadHistory }));
    }
  }

  fill(view, [
    h('div.view-head', [
      h('div.titles', [
        h('h1.page-title', 'Tag scan'),
        h('p.lede', 'Identify a card with the client\'s LF and HF search routines. Results are parsed from the client\'s own output.'),
      ]),
    ]),
    h('section.panel.is-accent', [
      h('div.panel-head', [h('h2', 'Run a search')]),
      h('div.panel-body.stack', [
        modeButtons,
        h('p.hint', 'LF search reads 125/134 kHz cards, HF search covers 13.56 MHz protocols, and Auto runs both plus a tune. Place the card flat on the matching antenna before starting.'),
      ]),
    ]),
    h('section.panel', [
      h('div.panel-head', [h('h2', 'Result')]),
      resultBody,
    ]),
    h('section.panel', [
      h('div.panel-head', [
        h('h2', 'Scan history'),
        h('button.btn.is-ghost.is-sm', { onclick: loadHistory }, 'Reload'),
      ]),
      historyBody,
    ]),
  ]);

  fill(resultBody, empty('No scan yet', 'Choose a search above to read whatever card is on the antenna.'));
  loadModes();
  loadHistory();
  unsubscribes.push(store.on('session', syncEnabled));

  return [view, () => unsubscribes.forEach((off) => off())];
}
