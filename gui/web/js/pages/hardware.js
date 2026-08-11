// Hardware — the client session, the connected device and everything `hw` can do.

import { h, fill, leader, copyText } from '../core/dom.js';
import { api } from '../core/api.js';
import { store } from '../core/store.js';
import * as fmt from '../core/fmt.js';
import { loading, empty, errorState, offlineState, notRunningState } from '../components/states.js';
import { resonanceChart } from '../components/charts.js';
import { confirmAction, showOutput, openModal } from '../components/modal.js';
import { reportError, toast } from '../core/notify.js';
import { icon } from '../components/icons.js';

export function mount({ router }) {
  const view = h('div.view');
  const unsubscribes = [];

  /* ------------------------------------------------------ session control */
  const sessionBody = h('div.panel-body.stack');
  const portSelect = h('select.select', { 'aria-label': 'Serial port' });
  const portNote = h('p.hint');

  async function loadPorts() {
    fill(portSelect, h('option', { value: '' }, 'Loading ports…'));
    try {
      const response = await api.devices();
      const options = [h('option', { value: '' }, 'Offline (no device)')];
      response.ports.forEach((port) => {
        const label = [
          port.path,
          port.isProxmark ? '· Proxmark3' : (port.match ? `· ${port.match}` : ''),
          port.access.writable ? '' : '· no access',
        ].filter(Boolean).join(' ');
        options.push(h('option', { value: port.path }, label));
      });
      fill(portSelect, options);
      const session = store.get('session');
      if (session.port) portSelect.value = session.port;
      else {
        const detected = response.ports.find((port) => port.isProxmark);
        if (detected) portSelect.value = detected.path;
      }

      const blocked = response.ports.filter((port) => port.isProxmark && !port.access.writable);
      const warnings = [...response.warnings, ...blocked.map((port) => port.access.detail)];
      fill(portNote, warnings.length
        ? warnings.join(' ')
        : `${response.ports.length} port${response.ports.length === 1 ? '' : 's'} detected. A Proxmark3 is identified by its USB vendor ID (9ac4:4b8f) or udev vendor string.`);
    } catch (error) {
      fill(portSelect, h('option', { value: '' }, 'Could not enumerate ports'));
      fill(portNote, error.message);
    }
  }

  function renderSession() {
    const session = store.get('session');
    fill(sessionBody, [
      h('div.kv-grid', [
        leader('Status', session.detail || session.status,
          { level: session.status === 'online' ? 'success' : (session.status === 'error' ? 'error' : null) }),
        leader('Serial port', session.port || 'not attached'),
        leader('Prompt', session.prompt?.trim() || null),
        leader('Process id', session.pid),
        leader('Uptime', fmt.duration(session.uptime)),
        leader('Commands run', session.commandCount),
        leader('Last command', session.lastCommand),
        leader('Client binary', session.binary, { title: session.binary || '' }),
      ]),
      session.lastError ? h('p.error', session.lastError) : null,
      h('div.field', [
        h('label', { for: 'port-select' }, 'Serial port'),
        portSelect,
        portNote,
      ]),
      h('div.row-wrap', [
        h('button.btn.is-primary', {
          onclick: () => act(() => api.sessionStart(portSelect.value || '', false), 'Client started'),
          disabled: session.running,
        }, [icon('play', { size: 14 }), 'Start client']),
        h('button.btn', {
          onclick: () => act(() => api.sessionRestart(portSelect.value || '', false), 'Client restarted'),
        }, [icon('refresh', { size: 14 }), 'Restart']),
        h('button.btn', {
          onclick: () => act(() => api.sessionStop(), 'Client stopped'),
          disabled: !session.running,
        }, [icon('stop', { size: 14 }), 'Stop']),
        h('button.btn', {
          onclick: () => attachDevice(),
          disabled: !session.running,
          title: 'Attach the running client to a device without restarting it',
        }, [icon('plug', { size: 14 }), 'Attach device']),
        h('button.btn.is-ghost', { onclick: loadPorts }, 'Rescan ports'),
      ]),
    ]);
  }

  /**
   * Attach the running client to a device. When the client refuses — most often
   * because the firmware was built from a different revision — show what that
   * means and what to do about it, not just the raw error text.
   */
  async function attachDevice() {
    if (!portSelect.value) {
      toast('warning', 'Pick a port first', 'Choose the serial port the Proxmark3 is on.');
      return;
    }
    const command = `hw connect -p ${portSelect.value}`;
    try {
      const response = await api.connect(portSelect.value);
      if (response.connected) {
        toast('success', 'Device attached', portSelect.value);
        loadVersion();
        loadStatus();
        return;
      }
      const diagnosis = response.diagnosis;
      await openModal({
        title: diagnosis ? diagnosis.title : 'Could not attach the device',
        danger: true,
        wide: true,
        body: h('div.stack', [
          diagnosis ? h('div.stack-sm', [
            h('p', diagnosis.explanation),
            h('div.eyebrow', 'What to do'),
            h('p.muted', diagnosis.remedy),
            diagnosis.docs
              ? h('p.hint', `See ${diagnosis.docs} in this repository.`)
              : null,
          ]) : h('p.muted', 'The client did not attach. Its output is below.'),
          h('div.stack-sm', [
            h('div.eyebrow', `Output of ${command}`),
            h('pre.output', response.result.output || '(no output)'),
          ]),
        ]),
        actions: [
          { label: 'Try again', run: (close) => { close(null); attachDevice(); } },
          { label: 'Close', primary: true, run: (close) => close(null) },
        ],
      });
    } catch (error) {
      reportError(error, 'Connect failed');
    }
  }

  async function act(run, successMessage) {
    try {
      const response = await run();
      store.patch({ session: response.session });
      toast('success', successMessage, response.session.detail);
      loadPorts();
    } catch (error) {
      reportError(error, 'Session command failed');
    }
  }

  const sessionPanel = h('section.panel.is-accent', [
    h('div.panel-head', [h('h2', 'Client session')]),
    sessionBody,
  ]);

  /* -------------------------------------------------------------- version */
  const versionBody = h('div.panel-body');
  async function loadVersion() {
    fill(versionBody, loading('Reading hw version…'));
    try {
      const response = await api.hwVersion();
      const version = response.version;
      fill(versionBody, h('div.stack', [
        version.sections.length
          ? h('div.stack', version.sections.map((section) => h('div.stack-sm', [
              section.name ? h('div.eyebrow', section.name) : null,
              ...section.entries.map((entry) => leader(entry.key, entry.value, { level: entry.level === 'normal' ? null : null })),
            ])))
          : empty('No version details', 'The client returned output this view could not break down. The raw text is below.'),
        h('details', [
          h('summary.eyebrow', { style: { cursor: 'pointer' } }, 'Raw output'),
          h('pre.output', version.raw),
        ]),
      ]));
    } catch (error) {
      if (error.isUnavailable) {
        fill(versionBody, notRunningState({
          binary: store.get('clientBinary'),
          start: () => act(() => api.sessionStart(null, true), 'Client started'),
        }));
      } else {
        fill(versionBody, errorState(error, { retry: loadVersion }));
      }
    }
  }

  const versionPanel = h('section.panel', [
    h('div.panel-head', [
      h('h2', 'Versions'),
      h('button.btn.is-ghost.is-sm', { onclick: loadVersion }, 'Reload'),
    ]),
    versionBody,
  ]);

  /* --------------------------------------------------------- device status */
  const statusBody = h('div.panel-body');
  async function loadStatus() {
    fill(statusBody, loading('Querying the device…'));
    try {
      const response = await api.hwStatus();
      const parsed = response.status;
      fill(statusBody, parsed.sections.length
        ? h('div.stack', parsed.sections.map((section) => h('div.stack-sm', [
            section.name ? h('div.eyebrow', section.name) : null,
            h('div.kv-grid', section.entries.map((entry) => leader(entry.key, entry.value))),
          ])))
        : h('pre.output', parsed.raw));
    } catch (error) {
      if (error.isOffline) {
        fill(statusBody, offlineState('Runtime status'));
      } else if (error.isUnavailable) {
        fill(statusBody, notRunningState({ binary: store.get('clientBinary') }));
      } else {
        fill(statusBody, errorState(error, { retry: loadStatus }));
      }
    }
  }

  const statusPanel = h('section.panel', [
    h('div.panel-head', [
      h('h2', 'Device runtime status'),
      h('button.btn.is-ghost.is-sm', { onclick: loadStatus }, 'Query'),
    ]),
    statusBody,
  ]);

  /* --------------------------------------------------------------- antenna */
  const tuneBody = h('div.panel-body');
  fill(tuneBody, empty('Not measured',
    'A tune measures antenna voltages. It does not change any device setting.',
    { label: 'Run hw tune', run: () => loadTune() }));

  async function loadTune() {
    fill(tuneBody, loading('Sweeping the LF antenna and reading the HF carrier…'));
    try {
      const response = await api.hwTune();
      const tune = response.tune;
      fill(tuneBody, h('div.stack', [
        resonanceChart({ measurements: tune.measurements, height: 220 }),
        h('div.table-wrap', h('table.data', [
          h('thead', h('tr', [h('th', 'Band'), h('th', 'Point'), h('th.num', 'Voltage')])),
          h('tbody', tune.measurements.map((measurement) => h('tr', [
            h('td', h('span', { class: measurement.band === 'LF' ? 'band-lf' : 'band-hf' }, measurement.band)),
            h('td', measurement.label),
            h('td.num', fmt.volts(measurement.volts)),
          ]))),
        ])),
        h('div.kv-grid', Object.entries(tune.verdicts).map(([band, verdict]) =>
          leader(`${band} antenna`, verdict, {
            level: verdict === 'ok' ? 'success' : (verdict === 'marginal' ? 'warning' : 'error'),
          }))),
        h('details', [
          h('summary.eyebrow', { style: { cursor: 'pointer' } }, 'Raw output'),
          h('pre.output', tune.raw),
        ]),
      ]));
    } catch (error) {
      if (error.isOffline) fill(tuneBody, offlineState('Antenna tuning'));
      else fill(tuneBody, errorState(error, { retry: loadTune, title: 'Tune failed' }));
    }
  }

  const tunePanel = h('section.panel', [
    h('div.panel-head', [
      h('h2', 'Antenna tuning'),
      h('button.btn.is-sm', { onclick: loadTune }, 'Measure'),
    ]),
    tuneBody,
  ]);

  /* --------------------------------------------------------------- actions */
  const actionsBody = h('div.panel-body.stack');
  async function loadActions() {
    fill(actionsBody, loading());
    try {
      const response = await api.hwActions();
      fill(actionsBody, [
        h('p.hint', 'Each button runs the client command shown beneath it. Actions that interrupt the link ask for confirmation first.'),
        h('div.grid-3', response.actions.map((action) => h('div.stack-sm', [
          h('button.btn', {
            class: action.confirm ? 'is-danger' : '',
            style: { width: '100%', justifyContent: 'center' },
            onclick: () => runAction(action),
          }, action.label),
          h('code.mono.faint', { style: { fontSize: 'var(--text-xs)' } }, action.command),
        ]))),
        h('div.stack-sm', [
          h('div.eyebrow', 'Device debug level'),
          h('p.hint', 'Controls how much the device prints over the wire (hw dbg).'),
          h('div.btn-group', [0, 1, 2, 3, 4].map((level) => h('button.btn.is-sm', {
            onclick: async () => {
              try {
                const response = await api.hwDbg(level);
                toast(response.result.ok ? 'success' : 'warning',
                  `Debug level ${level}`, response.result.output.split('\n')[0] || '');
              } catch (error) { reportError(error, 'Could not set the debug level'); }
            },
          }, String(level)))),
        ]),
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
      const response = await api.hwAction(action.id, true);
      toast(response.result.ok ? 'success' : 'warning', action.label,
        `Finished in ${response.result.duration}s`);
      await showOutput(action.command, response.result.output);
    } catch (error) {
      reportError(error, `${action.label} failed`);
    }
  }

  const actionsPanel = h('section.panel', [
    h('div.panel-head', [h('h2', 'Device actions')]),
    actionsBody,
  ]);

  /* -------------------------------------------------------------- assembly */
  fill(view, [
    h('div.view-head', [
      h('div.titles', [
        h('h1.page-title', 'Hardware'),
        h('p.lede', 'Attach the client to a Proxmark3, inspect firmware and antennas, and run device operations.'),
      ]),
      h('div.view-actions', [
        h('button.btn.is-sm', {
          onclick: async () => {
            const okay = await copyText(JSON.stringify(store.get('session'), null, 2));
            toast(okay ? 'success' : 'error', okay ? 'Session details copied' : 'Copy failed');
          },
        }, 'Copy session details'),
      ]),
    ]),
    sessionPanel,
    h('div.grid-2', [versionPanel, statusPanel]),
    tunePanel,
    actionsPanel,
  ]);

  renderSession();
  loadPorts();
  loadActions();
  // The client runs one command at a time, so chain the panels that need one
  // instead of firing them together.
  (async () => {
    await loadVersion();
    if (store.get('session').status === 'online') await loadStatus();
    else fill(statusBody, offlineState('Runtime status'));
  })();

  unsubscribes.push(store.on('session', renderSession));

  return [view, () => unsubscribes.forEach((off) => off())];
}
