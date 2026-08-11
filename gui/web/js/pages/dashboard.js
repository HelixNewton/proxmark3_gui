// Dashboard — the state of the instrument, the client and the host in one view.
//
// Every figure here is measured: device state comes from the client's prompt and
// `hw version`, antenna readings from `hw tune`, host metrics from psutil. Where
// a reading needs hardware that is not attached, the widget says so rather than
// showing a zero.

import { h, fill, leader } from '../core/dom.js';
import { api } from '../core/api.js';
import { store } from '../core/store.js';
import * as fmt from '../core/fmt.js';
import { areaChart, barRow, resonanceChart } from '../components/charts.js';
import { loading, empty, errorState, offlineState } from '../components/states.js';
import { icon } from '../components/icons.js';
import { reportError, toast } from '../core/notify.js';

export function mount({ router }) {
  const view = h('div.view');
  const unsubscribes = [];
  const charts = [];

  /* ------------------------------------------------------------ hero band */
  const sessionReadout = h('div.hero-readouts');
  const heroPanel = h('section.panel.is-accent', [
    h('div.panel-head', [
      h('h2', 'Instrument state'),
      h('div.row', [
        h('button.btn.is-sm', {
          onclick: async () => {
            try {
              const response = await api.sessionRestart(null, true);
              store.patch({ session: response.session });
              toast('success', 'Client restarted', response.session.detail);
            } catch (error) { reportError(error, 'Restart failed'); }
          },
        }, 'Restart client'),
        h('button.btn.is-sm.is-primary', {
          onclick: () => router.navigate('/hardware'),
        }, 'Hardware'),
      ]),
    ]),
    sessionReadout,
  ]);

  function renderHero() {
    const session = store.get('session');
    const host = store.get('host');
    const metrics = store.latestMetrics;
    const client = metrics?.client;

    fill(sessionReadout, [
      h('div.stat', [
        h('div.stat-head', [h('span.eyebrow', 'Device link'), statePill(session.status)]),
        h('div.readout', {
          style: session.status === 'error' ? { color: 'var(--err)' } : null,
        }, session.status === 'online' ? 'ONLINE' : session.status.toUpperCase()),
        h('div.muted', { style: { fontSize: 'var(--text-xs)' } }, session.detail || ''),
        session.status === 'error'
          ? h('button.btn.is-sm.is-danger', {
              style: { marginTop: '0.35rem' },
              onclick: () => router.navigate('/hardware'),
            }, 'Reconnect')
          : null,
      ]),
      h('div.stat', [
        h('div.eyebrow', 'Serial port'),
        h('div.readout', { style: { fontSize: 'var(--text-lg)' } }, session.port || 'none'),
        h('div.muted', { style: { fontSize: 'var(--text-xs)' } },
          session.port ? 'Attached by the client' : 'Client is running offline'),
      ]),
      h('div.stat', [
        h('div.eyebrow', 'Session uptime'),
        h('div.readout', { style: { fontSize: 'var(--text-lg)' } }, fmt.duration(session.uptime)),
        h('div.muted', { style: { fontSize: 'var(--text-xs)' } },
          `${session.commandCount} command${session.commandCount === 1 ? '' : 's'} run`),
      ]),
      h('div.stat', [
        h('div.eyebrow', 'Client process'),
        h('div.readout', { style: { fontSize: 'var(--text-lg)' } },
          client?.running ? `${fmt.bytes(client.rss)}` : '—'),
        h('div.muted', { style: { fontSize: 'var(--text-xs)' } },
          client?.running ? `pid ${client.pid} · ${fmt.percent(client.cpuPercent, 1)} cpu` : 'not running'),
      ]),
      h('div.stat', [
        h('div.eyebrow', 'Host'),
        h('div.readout', { style: { fontSize: 'var(--text-lg)' } }, host.hostname || '—'),
        h('div.muted', { style: { fontSize: 'var(--text-xs)' } },
          host.system ? `${host.system} · ${host.cores} cores` : 'host details unavailable'),
      ]),
    ]);
  }

  function statePill(status) {
    const label = { online: 'Online', offline: 'Offline', starting: 'Starting',
      stopped: 'Stopped', error: 'Error' }[status] || status;
    return h('span.pill', { dataset: { state: status } }, [h('span.dot'), label]);
  }

  /* ---------------------------------------------------------- host metrics */
  const cpuChartHost = h('div');
  const memChartHost = h('div');
  const netChartHost = h('div');
  const coreHost = h('div');
  const metricsFoot = h('div.panel-foot');

  const cpuChart = areaChart({
    series: [], height: 110, color: 'var(--hf)', label: 'CPU load',
    format: (v) => `${Math.round(v)}%`, min: 0, max: 100,
  });
  const memChart = areaChart({
    series: [], height: 110, color: 'var(--lf)', label: 'Memory in use',
    format: (v) => `${Math.round(v)}%`, min: 0, max: 100,
  });
  const netChart = areaChart({
    series: [], height: 110, color: 'var(--hf)', label: 'Network receive rate',
    format: (v) => fmt.bytes(v, 0),
  });
  charts.push(cpuChart, memChart, netChart);
  cpuChartHost.appendChild(cpuChart.node);
  memChartHost.appendChild(memChart.node);
  netChartHost.appendChild(netChart.node);

  function renderMetrics() {
    if (!store.get('metricsAvailable')) {
      fill(metricsFoot, 'Host metrics need the psutil package. Install it with `pip install psutil` and restart the server.');
      [cpuChartHost, memChartHost, netChartHost, coreHost].forEach((host) => fill(host,
        empty('Metric unavailable', 'psutil is not installed, so the host cannot be sampled.')));
      return;
    }
    const latest = store.latestMetrics;
    cpuChart.update(store.series((s) => s.cpu?.percent));
    memChart.update(store.series((s) => s.memory?.percent));
    netChart.update(store.series((s) => s.net?.rxRate));
    fill(coreHost, latest?.cpu?.perCore
      ? barRow({
          values: latest.cpu.perCore,
          labels: latest.cpu.perCore.map((_, i) => String(i)),
          color: 'var(--hf)',
        })
      : loading('Waiting for the first sample…'));
    fill(metricsFoot, latest
      ? `Sampled every ${store.get('metrics').length > 1 ? '2' : '2'} s · load ${latest.cpu?.loadAvg?.join(' ') || '—'} · memory ${fmt.bytes(latest.memory?.used)} of ${fmt.bytes(latest.memory?.total)} · net ↓ ${fmt.rate(latest.net?.rxRate)} ↑ ${fmt.rate(latest.net?.txRate)}`
      : 'Waiting for the metrics sampler…');
  }

  const metricsPanel = h('section.panel', [
    h('div.panel-head', [h('h2', 'Host telemetry'), h('span.eyebrow', 'live · 2 s')]),
    h('div.panel-body.stack', [
      h('div.grid-3', [
        h('div.stack-sm', [h('div.eyebrow', 'CPU load'), cpuChartHost]),
        h('div.stack-sm', [h('div.eyebrow', 'Memory in use'), memChartHost]),
        h('div.stack-sm', [h('div.eyebrow', 'Network receive'), netChartHost]),
      ]),
      h('div.stack-sm', [h('div.eyebrow', 'Per-core load'), coreHost]),
    ]),
    metricsFoot,
  ]);

  /* -------------------------------------------------------- antenna panel */
  const antennaBody = h('div.panel-body');
  const antennaPanel = h('section.panel', [
    h('div.panel-head', [
      h('h2', 'Antenna resonance'),
      h('button.btn.is-sm', { onclick: () => measureAntenna() }, 'Measure'),
    ]),
    antennaBody,
  ]);

  fill(antennaBody, empty(
    'Not measured yet',
    'A tune sweeps the LF antenna and reads the HF carrier. It takes a few seconds and needs a connected device.',
    { label: 'Run hw tune', run: () => measureAntenna() },
  ));

  async function measureAntenna() {
    fill(antennaBody, loading('Sweeping the antenna — this takes a few seconds…'));
    try {
      const response = await api.hwTune();
      const tune = response.tune;
      fill(antennaBody, h('div.stack', [
        resonanceChart({ measurements: tune.measurements }),
        h('div.kv-grid', [
          leader('LF peak', tune.lfPeak
            ? `${fmt.volts(tune.lfPeak.volts)} @ ${fmt.frequency(tune.lfPeak.freqKHz)}`
            : null, { valueClass: 'band-lf' }),
          leader('HF carrier', tune.hf ? fmt.volts(tune.hf.volts) : null, { valueClass: 'band-hf' }),
          leader('LF verdict', tune.verdicts.LF, { level: verdictLevel(tune.verdicts.LF) }),
          leader('HF verdict', tune.verdicts.HF, { level: verdictLevel(tune.verdicts.HF) }),
          // Q-factor figures are reported per band under the same labels.
          ...Object.entries(tune.quality).flatMap(([band, figures]) =>
            Object.entries(figures).map(([key, value]) =>
              leader(`${band} ${key.toLowerCase()}`, value,
                { valueClass: band === 'LF' ? 'band-lf' : 'band-hf' }))),
        ]),
      ]));
    } catch (error) {
      if (error.isOffline) {
        fill(antennaBody, offlineState('Antenna tuning', { connect: () => router.navigate('/hardware') }));
      } else {
        fill(antennaBody, errorState(error, { retry: measureAntenna, title: 'Tune failed' }));
      }
    }
  }

  function verdictLevel(verdict) {
    if (!verdict) return null;
    if (verdict === 'ok') return 'success';
    if (verdict === 'marginal') return 'warning';
    return 'error';
  }

  /* -------------------------------------------------------- storage panel */
  const storageBody = h('div.panel-body.stack-sm');
  function renderStorage() {
    const storage = store.get('storage');
    if (!storage.length) {
      fill(storageBody, empty('No storage information',
        'The server could not read disk usage for the client directories.'));
      return;
    }
    fill(storageBody, storage.map((disk) => h('div.meter', [
      h('div.spread', [
        h('span.mono', { style: { fontSize: 'var(--text-sm)' } }, disk.mount || disk.name),
        h('span.mono.faint', { style: { fontSize: 'var(--text-xs)' } },
          `${fmt.bytes(disk.free)} free of ${fmt.bytes(disk.total)}`),
      ]),
      h('div.meter-bar', [h('div.meter-fill', {
        style: { width: `${disk.percent}%` },
        dataset: { level: fmt.usageLevel(disk.percent) },
      })]),
      h('div.faint.mono', { style: { fontSize: 'var(--text-xs)' } },
        `holds: ${disk.path}`),
    ])));
  }

  const storagePanel = h('section.panel', [
    h('div.panel-head', [h('h2', 'Storage')]),
    storageBody,
  ]);

  /* ------------------------------------------------------- activity panel */
  const activityList = h('div.activity-list');
  function renderActivity() {
    const activity = store.get('activity');
    if (!activity.length) {
      fill(activityList, empty('No activity yet',
        'Commands, device events and notifications appear here as they happen.'));
      return;
    }
    fill(activityList, activity.slice(0, 40).map((entry) => h('div.activity-item', {
      dataset: { level: entry.level },
    }, [
      h('span.marker'),
      h('span.what', [
        entry.title,
        entry.message ? h('span.faint', ` — ${entry.message}`) : null,
      ]),
      h('span.when', fmt.ago(entry.ts)),
    ])));
  }

  const activityPanel = h('section.panel', [
    h('div.panel-head', [
      h('h2', 'Activity'),
      h('button.btn.is-ghost.is-sm', { onclick: () => router.navigate('/logs') }, 'Open logs'),
    ]),
    activityList,
  ]);

  /* ------------------------------------------------------------ scan panel */
  const scanBody = h('div.panel-body');
  const scanPanel = h('section.panel', [
    h('div.panel-head', [
      h('h2', 'Last tag scan'),
      h('button.btn.is-sm', { onclick: () => router.navigate('/tags') }, 'Scan a tag'),
    ]),
    scanBody,
  ]);

  async function loadScans() {
    fill(scanBody, loading());
    try {
      const response = await api.scanHistory();
      const scan = response.scans[0];
      if (!scan) {
        fill(scanBody, empty('No scans yet',
          'Run an LF or HF search to identify a tag; the result lands here.',
          { label: 'Go to Tag scan', run: () => router.navigate('/tags') }));
        return;
      }
      fill(scanBody, h('div.stack-sm', [
        h('div.spread', [
          h('span.pill', { dataset: { state: scan.found ? 'success' : 'idle' } },
            [h('span.dot'), scan.found ? 'Tag identified' : 'Nothing found']),
          h('span.faint.mono', { style: { fontSize: 'var(--text-xs)' } }, fmt.ago(scan.ts)),
        ]),
        h('code.mono.faint', { style: { fontSize: 'var(--text-xs)' } }, scan.command),
        ...scan.identifiers.slice(0, 6).map((item) => leader(item.key, item.value)),
        ...(scan.identifiers.length ? [] : scan.findings.slice(0, 4).map(
          (finding) => h('div.finding', finding.text))),
      ]));
    } catch (error) {
      fill(scanBody, errorState(error, { retry: loadScans }));
    }
  }

  /* ------------------------------------------------------------- assembly */
  fill(view, [
    h('div.view-head', [
      h('div.titles', [
        h('h1.page-title', 'Dashboard'),
        h('p.lede', 'Live state of the Proxmark3, the client session and the machine running it.'),
      ]),
      h('div.view-actions', [
        h('button.btn.is-sm', { onclick: () => router.resolve(), title: 'Refresh (R)' },
          [icon('refresh', { size: 14 }), 'Refresh']),
      ]),
    ]),
    heroPanel,
    h('div.grid-instruments', [
      h('div.stack', [metricsPanel, antennaPanel]),
      h('div.stack', [scanPanel, storagePanel, activityPanel]),
    ]),
  ]);

  renderHero();
  renderMetrics();
  renderStorage();
  renderActivity();
  loadScans();

  unsubscribes.push(store.on('session', renderHero));
  unsubscribes.push(store.on('metrics', () => { renderHero(); renderMetrics(); }));
  unsubscribes.push(store.on('storage', renderStorage));
  unsubscribes.push(store.on('activity', renderActivity));
  unsubscribes.push(store.on('metricsAvailable', renderMetrics));

  // Refresh disk usage on a slow cadence — it changes far less than CPU.
  const storageTimer = setInterval(() => {
    api.metrics()
      .then((response) => store.patch({ storage: response.storage || [] }))
      .catch(() => { /* the panel keeps its last known values */ });
  }, 30000);

  return [view, () => {
    unsubscribes.forEach((off) => off());
    charts.forEach((chart) => chart.destroy?.());
    clearInterval(storageTimer);
  }];
}
