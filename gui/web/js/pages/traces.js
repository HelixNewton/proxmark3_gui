// Traces — load protocol captures, annotate them and save the trace buffer.

import { h, fill, copyText, downloadText } from '../core/dom.js';
import { api } from '../core/api.js';
import * as fmt from '../core/fmt.js';
import { loading, empty, errorState } from '../components/states.js';
import { reportError, toast } from '../core/notify.js';

export function mount() {
  const view = h('div.view');
  const outputBody = h('div.panel-body');
  const rootSelect = h('select.select', { 'aria-label': 'Source directory' });
  const fileSelect = h('select.select', { 'aria-label': 'Trace file' });
  const protocolSelect = h('select.select', { 'aria-label': 'Protocol' });

  const options = {
    useBuffer: h('input', { type: 'checkbox', checked: true }),
    markCrc: h('input', { type: 'checkbox', checked: true }),
    relative: h('input', { type: 'checkbox' }),
    microseconds: h('input', { type: 'checkbox' }),
    frameDelay: h('input', { type: 'checkbox' }),
    hexdump: h('input', { type: 'checkbox' }),
  };

  let lastOutput = '';

  function toggle(key, label, hint) {
    return h('label.switch', { title: hint }, [
      options[key],
      h('span.track'),
      h('span', { style: { fontSize: 'var(--text-sm)' } }, label),
    ]);
  }

  async function loadProtocols() {
    try {
      const response = await api.traceProtocols();
      fill(protocolSelect, [
        h('option', { value: '' }, 'Auto — let the client decide'),
        ...response.protocols.map((protocol) => h('option', { value: protocol }, protocol)),
      ]);
    } catch (error) {
      fill(protocolSelect, h('option', { value: '' }, 'Could not load protocols'));
    }
  }

  async function loadRoots() {
    try {
      const response = await api.fileRoots();
      const preferred = response.roots.filter((root) =>
        ['traces', 'repo-traces', 'dumps', 'user', 'logs'].includes(root.name));
      fill(rootSelect, (preferred.length ? preferred : response.roots)
        .map((root) => h('option', { value: root.name }, `${root.name} — ${root.path}`)));
      await loadFiles();
    } catch {
      fill(rootSelect, h('option', 'Could not list directories'));
    }
  }

  async function loadFiles() {
    fill(fileSelect, h('option', 'Loading…'));
    try {
      const response = await api.fileList(rootSelect.value, '');
      const traces = response.entries.filter((entry) =>
        !entry.isDir && ['.trace', '.pm3', '.bin'].includes(entry.suffix));
      fill(fileSelect, traces.length
        ? traces.map((entry) => h('option', { value: entry.path }, `${entry.name} · ${fmt.bytes(entry.size)}`))
        : [h('option', { value: '' }, 'No trace files here')]);
    } catch (error) {
      fill(fileSelect, h('option', { value: '' }, error.message));
    }
  }

  rootSelect.addEventListener('change', loadFiles);

  async function loadTrace() {
    if (!fileSelect.value) {
      toast('warning', 'Pick a file', 'Choose a trace file to load into the trace buffer.');
      return;
    }
    fill(outputBody, loading('Loading the trace into the client buffer…'));
    try {
      const response = await api.traceLoad(rootSelect.value, fileSelect.value);
      showOutputText(response.result.output);
      toast('success', 'Trace loaded', fileSelect.value);
    } catch (error) {
      fill(outputBody, errorState(error, { retry: loadTrace, title: 'Load failed' }));
    }
  }

  async function annotate() {
    fill(outputBody, loading('Annotating the trace buffer…'));
    try {
      const response = await api.traceList({
        protocol: protocolSelect.value,
        useBuffer: options.useBuffer.checked,
        markCrc: options.markCrc.checked,
        relative: options.relative.checked,
        microseconds: options.microseconds.checked,
        frameDelay: options.frameDelay.checked,
        hexdump: options.hexdump.checked,
      });
      showOutputText(response.result.output);
    } catch (error) {
      fill(outputBody, errorState(error, { retry: annotate, title: 'Annotation failed' }));
    }
  }

  async function saveTrace() {
    const name = prompt('Save the trace buffer as (letters, digits, dot, dash, underscore):', `trace_${Date.now()}`);
    if (!name) return;
    try {
      const response = await api.traceSave(name);
      toast('success', 'Trace saved', response.path);
      showOutputText(response.result.output);
    } catch (error) {
      reportError(error, 'Save failed');
    }
  }

  function showOutputText(text) {
    lastOutput = text || '';
    if (!lastOutput.trim()) {
      fill(outputBody, empty('No output',
        'The client returned nothing. If the trace buffer is empty, load a file or capture a trace first.'));
      return;
    }
    fill(outputBody, h('div.stack-sm', [
      h('div.row-wrap', [
        h('button.btn.is-sm', {
          onclick: async () => {
            const okay = await copyText(lastOutput);
            toast(okay ? 'success' : 'error', okay ? 'Output copied' : 'Copy failed');
          },
        }, 'Copy'),
        h('button.btn.is-sm', {
          onclick: () => downloadText(`pm3-trace-${Date.now()}.txt`, lastOutput),
        }, 'Download'),
      ]),
      h('pre.output', { style: { maxHeight: '40rem' } }, lastOutput),
    ]));
  }

  fill(view, [
    h('div.view-head', [
      h('div.titles', [
        h('h1.page-title', 'Traces'),
        h('p.lede', 'Protocol traces captured by the device or loaded from disk, annotated by the client\'s own decoders.'),
      ]),
    ]),
    h('div.grid-2', [
      h('section.panel', [
        h('div.panel-head', [h('h2', 'Load a trace')]),
        h('div.panel-body.stack', [
          h('div.field', [h('label', 'Directory'), rootSelect]),
          h('div.field', [h('label', 'File'), fileSelect]),
          h('div.row-wrap', [
            h('button.btn.is-primary', { onclick: loadTrace }, 'Load into buffer'),
            h('button.btn', { onclick: saveTrace }, 'Save buffer to file'),
          ]),
          h('p.hint', 'Loading replaces the client\'s trace buffer. Saving writes it to the GUI scratch directory under ~/.proxmark3.'),
        ]),
      ]),
      h('section.panel', [
        h('div.panel-head', [h('h2', 'Annotate')]),
        h('div.panel-body.stack', [
          h('div.field', [
            h('label', 'Protocol'),
            protocolSelect,
            h('p.hint', 'Picks the decoder used to label each frame. Auto lets the client choose based on the capture.'),
          ]),
          h('div.stack-sm', [
            toggle('useBuffer', 'Use the loaded buffer', 'Otherwise the client downloads a fresh trace from the device'),
            toggle('markCrc', 'Mark CRC bytes', 'Highlights the checksum bytes in each frame'),
            toggle('relative', 'Relative times', 'Show gap and duration instead of absolute timestamps'),
            toggle('microseconds', 'Microseconds', 'Times in µs instead of clock cycles'),
            toggle('frameDelay', 'Frame delay times', 'Adds the inter-frame delay column'),
            toggle('hexdump', 'Hex dump', 'Emit a hexdump suitable for import into Wireshark'),
          ]),
          h('button.btn.is-primary', { onclick: annotate }, 'Annotate trace'),
        ]),
      ]),
    ]),
    h('section.panel', [
      h('div.panel-head', [h('h2', 'Trace output')]),
      outputBody,
    ]),
  ]);

  fill(outputBody, empty('Nothing decoded yet',
    'Load a trace file or annotate whatever is already in the client\'s trace buffer.'));
  loadProtocols();
  loadRoots();

  return view;
}
