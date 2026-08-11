// Charts, drawn by hand in SVG and canvas.
//
// No charting library: the page must stay self-contained under a strict CSP, and
// the four shapes this instrument actually needs — a time series, a bar row, an
// antenna resonance curve and a very long waveform — each want different
// treatment anyway.
//
// Colour follows the band rule from tokens.css: amber is LF, cyan is HF. Series
// that are neither (host CPU, memory) use cyan as the neutral instrument hue and
// are distinguished by position and label, never by inventing new hues.

import { h, s, fill } from '../core/dom.js';
import { empty } from './states.js';

const PAD = { top: 8, right: 8, bottom: 18, left: 40 };

/* ============================================================ time series */

/**
 * areaChart({ series, height, color, format, label })
 * `series` is [{ ts, value }]; null values break the line instead of being
 * drawn as zero, so a gap in sampling reads as a gap.
 */
export function areaChart(options) {
  const {
    series = [], height = 120, color = 'var(--hf)', format = (v) => String(v),
    label = 'value', min: forcedMin = null, max: forcedMax = null, live = true,
  } = options;

  const root = h('div.chart', { style: { position: 'relative' } });

  function draw(data) {
    const points = data.filter((point) => Number.isFinite(point.value));
    if (points.length < 2) {
      fill(root, h('div.state', { style: { minHeight: `${height}px`, padding: 'var(--s-4)' } }, [
        h('p.state-msg.faint', live
          ? 'Waiting for the first samples…'
          : 'Not enough data points to plot.'),
      ]));
      return;
    }

    const width = Math.max(root.clientWidth || 320, 200);
    const innerW = width - PAD.left - PAD.right;
    const innerH = height - PAD.top - PAD.bottom;

    const values = points.map((p) => p.value);
    const lo = forcedMin ?? Math.min(0, ...values);
    const hi = forcedMax ?? Math.max(...values, lo + 1);
    const span = hi - lo || 1;

    const x = (i) => PAD.left + (i / (data.length - 1)) * innerW;
    const y = (v) => PAD.top + innerH - ((v - lo) / span) * innerH;

    // Build the path, lifting the pen across null gaps.
    let linePath = '';
    let areaPath = '';
    let penDown = false;
    data.forEach((point, i) => {
      if (!Number.isFinite(point.value)) { penDown = false; return; }
      const px = x(i);
      const py = y(point.value);
      if (!penDown) {
        linePath += `M${px.toFixed(1)},${py.toFixed(1)}`;
        areaPath += `M${px.toFixed(1)},${(PAD.top + innerH).toFixed(1)}L${px.toFixed(1)},${py.toFixed(1)}`;
        penDown = true;
      } else {
        linePath += `L${px.toFixed(1)},${py.toFixed(1)}`;
        areaPath += `L${px.toFixed(1)},${py.toFixed(1)}`;
      }
    });
    if (penDown) areaPath += `L${x(data.length - 1).toFixed(1)},${(PAD.top + innerH).toFixed(1)}Z`;

    const gradientId = `grad-${Math.random().toString(36).slice(2, 9)}`;
    const ticks = [lo, lo + span / 2, hi];

    const svg = s('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width: '100%',
      height,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': `${label}: ${format(values[values.length - 1])} now, ${format(Math.min(...values))} to ${format(Math.max(...values))} over the window`,
    }, [
      s('defs', null, [
        s('linearGradient', { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 }, [
          s('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.28 }),
          s('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }),
        ]),
      ]),
      // Horizontal graticule + value ticks.
      ...ticks.map((value) => s('g', null, [
        s('line', {
          x1: PAD.left, x2: width - PAD.right, y1: y(value), y2: y(value),
          stroke: 'var(--edge)', 'stroke-width': 1,
          'stroke-dasharray': value === lo ? '0' : '2 4',
        }),
        s('text', {
          x: PAD.left - 6, y: y(value) + 3, 'text-anchor': 'end',
          fill: 'var(--ink-faint)', 'font-size': 9, 'font-family': 'var(--font-mono)',
        }, format(value)),
      ])),
      s('path', { d: areaPath, fill: `url(#${gradientId})` }),
      s('path', {
        d: linePath, fill: 'none', stroke: color, 'stroke-width': 1.5,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }),
    ]);

    const cursor = s('g', { opacity: 0 }, [
      s('line', { y1: PAD.top, y2: PAD.top + innerH, stroke: color, 'stroke-width': 1, 'stroke-dasharray': '2 3' }),
      s('circle', { r: 3, fill: 'var(--void)', stroke: color, 'stroke-width': 1.5 }),
    ]);
    svg.appendChild(cursor);

    const tip = h('div.chart-tip', { hidden: true });
    fill(root, [svg, tip]);

    // Hover readout: exact value and time at the nearest sample.
    function move(event) {
      const rect = svg.getBoundingClientRect();
      const relative = ((event.clientX - rect.left) / rect.width) * width;
      const index = Math.round(((relative - PAD.left) / innerW) * (data.length - 1));
      const point = data[Math.max(0, Math.min(index, data.length - 1))];
      if (!point || !Number.isFinite(point.value)) { leave(); return; }
      const px = x(Math.max(0, Math.min(index, data.length - 1)));
      const py = y(point.value);
      cursor.setAttribute('opacity', '1');
      cursor.children[0].setAttribute('x1', px);
      cursor.children[0].setAttribute('x2', px);
      cursor.children[1].setAttribute('cx', px);
      cursor.children[1].setAttribute('cy', py);
      tip.hidden = false;
      fill(tip, [
        h('span.mono', format(point.value)),
        h('span.faint.mono', new Date(point.ts * 1000).toLocaleTimeString(undefined, { hour12: false })),
      ]);
      const leftPct = (px / width) * 100;
      tip.style.left = `${Math.min(Math.max(leftPct, 6), 94)}%`;
    }
    function leave() {
      cursor.setAttribute('opacity', '0');
      tip.hidden = true;
    }
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerleave', leave);
  }

  let current = series;
  draw(current);

  const observer = new ResizeObserver(() => draw(current));
  observer.observe(root);

  return {
    node: root,
    update(next) { current = next; draw(current); },
    destroy() { observer.disconnect(); },
  };
}

/* ================================================================ bar row */

/** Per-core CPU or any small set of labelled percentages. */
export function barRow({ values = [], labels = [], color = 'var(--hf)', format = (v) => `${v}%` }) {
  if (!values.length) return empty('No data', 'The sampler has not reported yet.');
  const max = Math.max(100, ...values);
  return h('div.bar-row', values.map((value, i) => h('div.bar-cell', {
    title: `${labels[i] ?? `#${i}`}: ${format(value)}`,
  }, [
    h('div.bar-track', [
      h('div.bar-fill', {
        style: { height: `${Math.max((value / max) * 100, 1.5)}%`, background: color },
      }),
    ]),
    h('span.bar-label.mono', labels[i] ?? String(i)),
  ])));
}

/* ====================================================== antenna resonance */

/**
 * The signature instrument view: the LF sweep as a resonance curve with the
 * measured peak marked, and the HF carrier as a separate reading. Both come
 * straight from `hw tune`.
 */
export function resonanceChart({ measurements = [], height = 190 }) {
  const lf = measurements.filter((m) => m.band === 'LF' && Number.isFinite(m.freqKHz));
  const hf = measurements.find((m) => m.band === 'HF');
  if (!lf.length && !hf) {
    return empty('No antenna measurements',
      'Run a tune to measure the LF sweep and the HF carrier voltage.');
  }

  const root = h('div.chart', { style: { position: 'relative' } });
  const sorted = [...lf].sort((a, b) => a.freqKHz - b.freqKHz);

  function draw() {
    const width = Math.max(root.clientWidth || 420, 260);
    const innerW = width - PAD.left - PAD.right;
    const innerH = height - PAD.top - PAD.bottom;
    if (!sorted.length) {
      fill(root, hfOnly(hf));
      return;
    }

    const fMin = sorted[0].freqKHz;
    const fMax = sorted[sorted.length - 1].freqKHz;
    const vMax = Math.max(...sorted.map((m) => m.volts), 1) * 1.15;
    const x = (f) => PAD.left + ((f - fMin) / (fMax - fMin || 1)) * innerW;
    const y = (v) => PAD.top + innerH - (v / vMax) * innerH;

    const path = sorted.map((m, i) => `${i ? 'L' : 'M'}${x(m.freqKHz).toFixed(1)},${y(m.volts).toFixed(1)}`).join('');
    const peak = sorted.reduce((best, m) => (m.volts > best.volts ? m : best), sorted[0]);

    fill(root, s('svg', {
      viewBox: `0 0 ${width} ${height}`, width: '100%', height,
      role: 'img',
      'aria-label': `LF antenna resonance: peak ${peak.volts.toFixed(2)} volts at ${peak.freqKHz.toFixed(2)} kilohertz`,
    }, [
      ...[0, vMax / 2, vMax].map((v) => s('g', null, [
        s('line', { x1: PAD.left, x2: width - PAD.right, y1: y(v), y2: y(v), stroke: 'var(--edge)', 'stroke-dasharray': v ? '2 4' : '0' }),
        s('text', { x: PAD.left - 6, y: y(v) + 3, 'text-anchor': 'end', fill: 'var(--ink-faint)', 'font-size': 9, 'font-family': 'var(--font-mono)' }, `${v.toFixed(0)}V`),
      ])),
      s('path', { d: `${path}L${x(fMax).toFixed(1)},${y(0)}L${x(fMin).toFixed(1)},${y(0)}Z`, fill: 'var(--lf)', opacity: 0.12 }),
      s('path', { d: path, fill: 'none', stroke: 'var(--lf)', 'stroke-width': 1.8, 'stroke-linejoin': 'round' }),
      // Peak marker — the number the operator is actually tuning for.
      s('line', { x1: x(peak.freqKHz), x2: x(peak.freqKHz), y1: y(peak.volts), y2: y(0), stroke: 'var(--lf)', 'stroke-dasharray': '3 3', opacity: 0.7 }),
      s('circle', { cx: x(peak.freqKHz), cy: y(peak.volts), r: 3.5, fill: 'var(--void)', stroke: 'var(--lf)', 'stroke-width': 2 }),
      s('text', {
        x: Math.min(x(peak.freqKHz) + 8, width - 90), y: y(peak.volts) - 6,
        fill: 'var(--lf)', 'font-size': 10, 'font-family': 'var(--font-mono)',
      }, `${peak.volts.toFixed(2)} V @ ${peak.freqKHz.toFixed(2)} kHz`),
      ...[fMin, (fMin + fMax) / 2, fMax].map((f) => s('text', {
        x: x(f), y: height - 4, 'text-anchor': f === fMin ? 'start' : (f === fMax ? 'end' : 'middle'),
        fill: 'var(--ink-faint)', 'font-size': 9, 'font-family': 'var(--font-mono)',
      }, `${f.toFixed(0)}k`)),
    ]));
  }

  function hfOnly(measurement) {
    return h('div.state', [h('p.state-msg', measurement
      ? `Only the HF carrier was measured: ${measurement.volts.toFixed(2)} V at 13.56 MHz.`
      : 'No LF sweep in this measurement.')]);
  }

  draw();
  const observer = new ResizeObserver(draw);
  observer.observe(root);
  return root;
}

/* ================================================================ waveform */

/**
 * The graph buffer, on canvas: 40 000 samples redraw instantly and pan/zoom
 * stays smooth. Renders the min/max envelope when the server decimated the
 * signal, so peaks survive the reduction.
 */
export function waveform({ points = [], envelope = null, height = 260, onCursor = null }) {
  const canvas = h('canvas', { style: { width: '100%', height: `${height}px`, display: 'block', cursor: 'crosshair' } });
  const readout = h('div.wave-readout.mono');
  const root = h('div.wave', [canvas, readout]);

  const view = { start: 0, end: points.length };
  let hover = null;

  function render() {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 600;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (!points.length) {
      ctx.fillStyle = '#4d6169';
      ctx.font = '12px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Graph buffer is empty — capture samples or load a trace.', width / 2, height / 2);
      return;
    }

    const mid = height / 2;
    // Graticule: centre line plus 8 vertical divisions, like a scope screen.
    ctx.strokeStyle = 'rgba(62, 224, 213, 0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 8; i += 1) {
      const x = (width / 8) * i;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let i = 1; i < 4; i += 1) {
      const y = (height / 4) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(62, 224, 213, 0.25)';
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(width, mid); ctx.stroke();

    const visible = points.slice(view.start, view.end);
    if (!visible.length) return;
    const fullView = view.start === 0 && view.end === points.length;
    const hasEnvelope = Boolean(envelope?.min && envelope?.max);

    const extremes = hasEnvelope && fullView
      ? [...envelope.min, ...envelope.max]
      : visible;
    const peak = Math.max(1, ...extremes.map((v) => Math.abs(v)));
    const scale = (height / 2 - 6) / peak;
    const step = width / visible.length;

    if (hasEnvelope && fullView) {
      // Zoomed out, the honest picture is the min/max band: a mean line across
      // 25 samples per pixel would be noise dressed up as signal.
      ctx.fillStyle = 'rgba(62, 224, 213, 0.75)';
      ctx.beginPath();
      envelope.max.forEach((value, i) => {
        const x = i * (width / envelope.max.length);
        i === 0 ? ctx.moveTo(x, mid - value * scale) : ctx.lineTo(x, mid - value * scale);
      });
      for (let i = envelope.min.length - 1; i >= 0; i -= 1) {
        ctx.lineTo(i * (width / envelope.min.length), mid - envelope.min[i] * scale);
      }
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.strokeStyle = '#3ee0d5';
      ctx.lineWidth = visible.length > width ? 1 : 1.4;
      ctx.beginPath();
      visible.forEach((value, i) => {
        const x = i * step;
        const y = mid - value * scale;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    if (hover !== null) {
      const x = hover * step;
      ctx.strokeStyle = 'rgba(242, 166, 59, 0.9)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
  }

  function updateReadout() {
    const visible = view.end - view.start;
    const sample = hover === null ? null : points[view.start + hover];
    const showingEnvelope = envelope?.min && view.start === 0 && view.end === points.length;
    fill(readout, [
      h('span', `${points.length.toLocaleString()} pts`),
      h('span.faint', `window ${view.start.toLocaleString()}–${view.end.toLocaleString()}`),
      showingEnvelope
        ? h('span.faint', 'min/max envelope — scroll to zoom in for individual samples')
        : null,
      sample === undefined || sample === null
        ? h('span.faint', 'hover to read a sample')
        : h('span.band-lf', `sample ${(view.start + hover).toLocaleString()} = ${sample}`),
      visible < points.length
        ? h('button.btn.is-sm.is-ghost', { onclick: () => { view.start = 0; view.end = points.length; render(); updateReadout(); } }, 'Reset zoom')
        : null,
    ]);
  }

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const visible = view.end - view.start;
    hover = Math.floor(((event.clientX - rect.left) / rect.width) * visible);
    hover = Math.max(0, Math.min(hover, visible - 1));
    render();
    updateReadout();
    if (onCursor) onCursor(view.start + hover, points[view.start + hover]);
  });
  canvas.addEventListener('pointerleave', () => { hover = null; render(); updateReadout(); });

  // Wheel zooms around the cursor; the operator is inspecting a signal, so the
  // point under the pointer must stay put.
  canvas.addEventListener('wheel', (event) => {
    if (!points.length) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const fraction = (event.clientX - rect.left) / rect.width;
    const visible = view.end - view.start;
    const factor = event.deltaY > 0 ? 1.25 : 0.8;
    const nextVisible = Math.max(32, Math.min(Math.round(visible * factor), points.length));
    const anchor = view.start + fraction * visible;
    view.start = Math.max(0, Math.round(anchor - fraction * nextVisible));
    view.end = Math.min(points.length, view.start + nextVisible);
    view.start = Math.max(0, view.end - nextVisible);
    render();
    updateReadout();
  }, { passive: false });

  render();
  updateReadout();
  const observer = new ResizeObserver(() => render());
  observer.observe(canvas);

  return {
    node: root,
    update(next) {
      points = next.points || [];
      envelope = next.envelope || null;
      view.start = 0;
      view.end = points.length;
      hover = null;
      render();
      updateReadout();
    },
    destroy() { observer.disconnect(); },
  };
}
