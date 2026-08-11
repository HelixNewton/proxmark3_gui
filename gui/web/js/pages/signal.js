// Signal — the client's graph buffer, plotted in the browser.
//
// The client normally shows this in a separate Qt window. Here the buffer is
// exported with `data save`, read back by the server and drawn on canvas, so the
// same samples are available with pan, zoom and a per-sample readout.

import { h, fill, leader } from '../core/dom.js';
import { api } from '../core/api.js';
import { store } from '../core/store.js';
import * as fmt from '../core/fmt.js';
import { loading, empty, errorState, offlineState } from '../components/states.js';
import { waveform } from '../components/charts.js';
import { showOutput } from '../components/modal.js';
import { reportError, toast } from '../core/notify.js';

export function mount({ router }) {
  const view = h('div.view');
  const unsubscribes = [];

  const plotHost = h('div');
  const statsBody = h('div.panel-body');
  const opsRow = h('div.row-wrap');
  const outputBody = h('div.panel-body');
  const chart = waveform({ points: [], height: 300 });
  plotHost.appendChild(chart.node);

  let lastBuffer = null;

  function renderStats(buffer) {
    if (!buffer) {
      fill(statsBody, empty('Buffer empty',
        'Capture samples from the device or load a trace file to fill the graph buffer.'));
      return;
    }
    fill(statsBody, h('div.kv-grid', [
      leader('Samples', fmt.number(buffer.count)),
      leader('Minimum', buffer.min),
      leader('Maximum', buffer.max),
      leader('Peak-to-peak', buffer.max - buffer.min),
      leader('Plotted points', fmt.number(buffer.points?.length || 0)),
      leader('Decimation', buffer.factor > 1 ? `${buffer.factor.toFixed(1)}× (min/max envelope shown)` : 'none'),
    ]));
  }

  function applyBuffer(buffer, resultOutput) {
    lastBuffer = buffer;
    if (buffer?.error) {
      fill(outputBody, errorState(new Error(buffer.error), { title: 'Could not read the buffer' }));
    }
    chart.update({ points: buffer?.points || [], envelope: buffer?.envelope || null });
    renderStats(buffer);
    if (resultOutput !== undefined) {
      fill(outputBody, resultOutput.trim()
        ? h('pre.output', resultOutput)
        : h('p.hint', 'The command produced no output.'));
    }
  }

  /* -------------------------------------------------------------- capture */
  const sampleInput = h('input.input', {
    type: 'number', min: 512, max: 40000, step: 512, value: 40000,
    'aria-label': 'Number of samples',
  });

  async function capture() {
    fill(outputBody, loading('Pulling samples from the device…'));
    try {
      const count = Number(sampleInput.value) || 40000;
      const response = await api.signalCapture(count, 1600);
      applyBuffer(response.buffer, response.result.output);
      toast('success', 'Samples captured', `${fmt.number(response.buffer.count)} samples in the graph buffer`);
    } catch (error) {
      if (error.isOffline) fill(outputBody, offlineState('Sample capture', { connect: () => router.navigate('/hardware') }));
      else fill(outputBody, errorState(error, { retry: capture, title: 'Capture failed' }));
    }
  }

  /* ------------------------------------------------------------ file load */
  const rootSelect = h('select.select', { 'aria-label': 'Source directory' });
  const fileSelect = h('select.select', { 'aria-label': 'Trace file' });

  async function loadRoots() {
    try {
      const response = await api.fileRoots();
      const traceRoots = response.roots.filter((root) =>
        ['traces', 'repo-traces', 'dumps', 'user', 'logs'].includes(root.name));
      fill(rootSelect, (traceRoots.length ? traceRoots : response.roots)
        .map((root) => h('option', { value: root.name }, `${root.name} — ${root.path}`)));
      await loadFiles();
    } catch (error) {
      fill(rootSelect, h('option', 'Could not list directories'));
    }
  }

  async function loadFiles() {
    fill(fileSelect, h('option', 'Loading…'));
    try {
      const response = await api.fileList(rootSelect.value, '');
      const traces = response.entries.filter((entry) =>
        !entry.isDir && ['.pm3', '.trace', '.txt'].includes(entry.suffix));
      fill(fileSelect, traces.length
        ? traces.map((entry) => h('option', { value: entry.path }, `${entry.name} · ${fmt.bytes(entry.size)}`))
        : [h('option', { value: '' }, 'No trace files in this directory')]);
    } catch (error) {
      fill(fileSelect, h('option', { value: '' }, error.message));
    }
  }

  rootSelect.addEventListener('change', loadFiles);

  async function loadTrace() {
    if (!fileSelect.value) {
      toast('warning', 'Pick a file', 'Choose a .pm3 or .trace file to load into the graph buffer.');
      return;
    }
    fill(outputBody, loading('Loading the file into the graph buffer…'));
    try {
      const response = await api.signalLoad(rootSelect.value, fileSelect.value, 1600);
      applyBuffer(response.buffer, response.result.output);
      toast('success', 'Trace loaded', `${fmt.number(response.buffer.count)} samples from ${fileSelect.value}`);
    } catch (error) {
      fill(outputBody, errorState(error, { retry: loadTrace, title: 'Load failed' }));
    }
  }

  /* -------------------------------------------------------------- buffer ops */
  async function loadOps() {
    try {
      const response = await api.signalOps();
      fill(opsRow, response.ops.map((op) => h('button.btn.is-sm', {
        title: `Runs \`${op.command}\``,
        onclick: () => runOp(op),
      }, op.label)));
    } catch (error) {
      fill(opsRow, errorState(error, { retry: loadOps }));
    }
  }

  async function runOp(op) {
    fill(outputBody, loading(`Running \`${op.command}\`…`));
    try {
      const response = await api.signalOp(op.id, 1600);
      applyBuffer(response.buffer, response.result.output);
    } catch (error) {
      fill(outputBody, errorState(error, { retry: () => runOp(op), title: `${op.label} failed` }));
    }
  }

  async function refreshBuffer() {
    fill(outputBody, loading('Reading the current graph buffer…'));
    try {
      const response = await api.signalBuffer(1600);
      applyBuffer(response.buffer, '');
      if (!response.buffer.count) {
        fill(outputBody, h('p.hint', 'The graph buffer is empty. Capture samples from the device or load a trace file.'));
      }
    } catch (error) {
      fill(outputBody, errorState(error, { retry: refreshBuffer }));
    }
  }

  /* ------------------------------------------------------------- assembly */
  fill(view, [
    h('div.view-head', [
      h('div.titles', [
        h('h1.page-title', 'Signal'),
        h('p.lede', 'The client\'s graph buffer: capture from the device, load a saved trace, transform it and read individual samples.'),
      ]),
      h('div.view-actions', [
        h('button.btn.is-sm', { onclick: refreshBuffer }, 'Reload buffer'),
      ]),
    ]),
    h('section.panel.is-accent', [
      h('div.panel-head', [
        h('h2', 'Graph buffer'),
        h('span.eyebrow', 'scroll to zoom · drag-free cursor readout'),
      ]),
      h('div.panel-body.is-flush', plotHost),
    ]),
    h('div.grid-2', [
      h('section.panel', [
        h('div.panel-head', [h('h2', 'Capture from device')]),
        h('div.panel-body.stack', [
          h('div.field', [
            h('label', 'Samples (512 – 40000)'),
            sampleInput,
            h('p.hint', 'Runs `data samples -n <count>`, which downloads the device\'s big buffer into the client graph buffer.'),
          ]),
          h('button.btn.is-primary', { onclick: capture }, 'Capture samples'),
        ]),
      ]),
      h('section.panel', [
        h('div.panel-head', [h('h2', 'Load a saved trace')]),
        h('div.panel-body.stack', [
          h('div.field', [h('label', 'Directory'), rootSelect]),
          h('div.field', [h('label', 'File'), fileSelect]),
          h('button.btn', { onclick: loadTrace }, 'Load into buffer'),
          h('p.hint', 'Runs `data load -f <path>`. Works with no device attached, which makes it useful for analysing captures offline.'),
        ]),
      ]),
    ]),
    h('section.panel', [
      h('div.panel-head', [h('h2', 'Buffer operations')]),
      h('div.panel-body.stack', [
        opsRow,
        h('p.hint', 'These run real `data` commands against the buffer and redraw the plot with the result.'),
      ]),
    ]),
    h('div.grid-2', [
      h('section.panel', [h('div.panel-head', [h('h2', 'Buffer statistics')]), statsBody]),
      h('section.panel', [h('div.panel-head', [h('h2', 'Command output')]), outputBody]),
    ]),
  ]);

  renderStats(null);
  fill(outputBody, h('p.hint', 'Output from the last capture, load or operation appears here.'));
  loadRoots();
  loadOps();
  refreshBuffer();

  return [view, () => {
    chart.destroy?.();
    unsubscribes.forEach((off) => off());
  }];
}
