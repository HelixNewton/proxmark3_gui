// Logs — the client's rolling session log, live and searchable.

import { h, fill, debounce, copyText, downloadText } from '../core/dom.js';
import { api } from '../core/api.js';
import { Socket } from '../core/ws.js';
import * as fmt from '../core/fmt.js';
import { loading, empty, errorState } from '../components/states.js';
import { toast } from '../core/notify.js';

const LEVELS = [
  ['all', 'All'],
  ['problems', 'Problems'],
  ['critical', 'Critical'],
  ['error', 'Error'],
  ['warning', 'Warning'],
  ['success', 'Success'],
  ['info', 'Info'],
  ['debug', 'Debug'],
];

export function mount({ params }) {
  const view = h('div.view');
  const viewport = h('div.log-viewport', { role: 'log', 'aria-label': 'Session log' });
  const fileSelect = h('select.select', { 'aria-label': 'Log file', style: { maxWidth: '18rem' } });
  const levelSelect = h('select.select', { 'aria-label': 'Severity', style: { maxWidth: '10rem' } },
    LEVELS.map(([value, label]) => h('option', { value }, label)));
  const searchInput = h('input.input', {
    type: 'search', placeholder: 'Search the log…', 'aria-label': 'Search log',
    value: params.get('q') || '', style: { maxWidth: '18rem' },
  });
  const counts = h('div.row-wrap');

  let autoscroll = true;
  let paused = false;
  let entries = [];
  let liveCount = 0;

  const autoscrollBtn = h('button.btn.is-sm.is-on', {
    'aria-pressed': 'true',
    onclick: () => {
      autoscroll = !autoscroll;
      autoscrollBtn.classList.toggle('is-on', autoscroll);
      autoscrollBtn.setAttribute('aria-pressed', String(autoscroll));
      if (autoscroll) viewport.scrollTop = viewport.scrollHeight;
    },
  }, 'Auto-scroll');

  const pauseBtn = h('button.btn.is-sm', {
    'aria-pressed': 'false',
    onclick: () => {
      paused = !paused;
      pauseBtn.classList.toggle('is-on', paused);
      pauseBtn.setAttribute('aria-pressed', String(paused));
      fill(pauseBtn, paused ? 'Resume stream' : 'Pause stream');
    },
  }, 'Pause stream');

  function matchesFilters(entry) {
    const level = levelSelect.value;
    if (level !== 'all') {
      const wanted = level === 'problems' ? ['warning', 'error', 'critical'] : [level];
      if (!wanted.includes(entry.level)) return false;
    }
    const query = searchInput.value.trim().toLowerCase();
    if (query && !entry.raw.toLowerCase().includes(query)) return false;
    return true;
  }

  /** Render a line, highlighting search hits without ever parsing HTML. */
  function lineNode(entry) {
    const query = searchInput.value.trim();
    let message;
    if (query && entry.message.toLowerCase().includes(query.toLowerCase())) {
      const parts = [];
      let index = 0;
      const lowered = entry.message.toLowerCase();
      const needle = query.toLowerCase();
      while (true) {
        const at = lowered.indexOf(needle, index);
        if (at === -1) { parts.push(entry.message.slice(index)); break; }
        parts.push(entry.message.slice(index, at));
        parts.push(h('mark', entry.message.slice(at, at + query.length)));
        index = at + query.length;
      }
      message = h('span.msg', parts);
    } else {
      message = h('span.msg', entry.message);
    }
    return h('div.logline', { dataset: { level: entry.level } }, [
      h('span.lvl', entry.level),
      h('span.ts', entry.time || ''),
      message,
    ]);
  }

  function render() {
    const visible = entries.filter(matchesFilters);
    if (!visible.length) {
      fill(viewport, entries.length
        ? empty('No matching entries', 'Nothing in this log matches the current severity and search.')
        : empty('Log is empty', 'The client writes a new log file per session. Run a command to produce entries.'));
      return;
    }
    fill(viewport, visible.map(lineNode));
    if (autoscroll) viewport.scrollTop = viewport.scrollHeight;
  }

  function renderCounts(byLevel) {
    fill(counts, Object.entries(byLevel || {})
      .sort((a, b) => b[1] - a[1])
      .map(([level, count]) => h('span.badge', {
        class: level === 'error' || level === 'critical' ? 'is-err'
          : (level === 'warning' ? 'is-warn' : (level === 'success' ? 'is-ok' : '')),
      }, `${level} ${count}`)));
  }

  async function load() {
    fill(viewport, loading('Reading the session log…'));
    try {
      const response = await api.logs({
        file: fileSelect.value || undefined,
        limit: 3000,
      });
      if (response.empty) {
        fill(viewport, empty('No session logs yet', response.reason));
        renderCounts({});
        return;
      }
      entries = response.entries;
      liveCount = 0;
      renderCounts(response.counts);
      render();
    } catch (error) {
      fill(viewport, errorState(error, { retry: load }));
    }
  }

  async function loadFiles() {
    try {
      const response = await api.logFiles();
      if (!response.files.length) {
        fill(fileSelect, h('option', { value: '' }, 'No log files'));
        return;
      }
      fill(fileSelect, response.files.map((file) => h('option', { value: file.name },
        `${file.name} · ${fmt.bytes(file.size)} · ${fmt.ago(file.modified)}`)));
    } catch {
      fill(fileSelect, h('option', { value: '' }, 'Could not list log files'));
    }
  }

  // Live tail over the event socket.
  const socket = new Socket('/ws/events');
  socket.addEventListener('logs.append', ({ detail }) => {
    if (paused) return;
    // Only the newest file is tailed; viewing an older one stays static.
    if (fileSelect.value && detail.file !== fileSelect.value) return;
    detail.entries.forEach((entry) => {
      entries.push(entry);
      liveCount += 1;
      if (matchesFilters(entry)) viewport.appendChild(lineNode(entry));
    });
    while (entries.length > 6000) entries.shift();
    while (viewport.childElementCount > 6000) viewport.removeChild(viewport.firstChild);
    if (autoscroll) viewport.scrollTop = viewport.scrollHeight;
  });
  socket.addEventListener('logs.rotated', ({ detail }) => {
    toast('info', 'New log file', `The client started writing ${detail.file}.`);
    loadFiles().then(load);
  });
  socket.connect();

  const onFilter = debounce(render, 180);
  levelSelect.addEventListener('change', render);
  searchInput.addEventListener('input', onFilter);
  fileSelect.addEventListener('change', load);

  fill(view, [
    h('div.view-head', [
      h('div.titles', [
        h('h1.page-title', 'Logs'),
        h('p.lede', 'The client writes one log per session under ~/.proxmark3/logs. New lines stream in as commands run.'),
      ]),
      h('div.view-actions', [
        h('button.btn.is-sm', {
          onclick: async () => {
            const text = entries.filter(matchesFilters).map((entry) => entry.raw).join('\n');
            const okay = await copyText(text);
            toast(okay ? 'success' : 'error', okay ? 'Log copied' : 'Copy failed',
              okay ? 'The filtered entries are on the clipboard.' : '');
          },
        }, 'Copy filtered'),
        h('button.btn.is-sm', {
          onclick: () => downloadText(fileSelect.value || 'pm3-log.txt',
            entries.filter(matchesFilters).map((entry) => entry.raw).join('\n')),
        }, 'Download'),
      ]),
    ]),
    h('section.panel', [
      h('div.panel-head', [
        h('h2', 'Session log'),
        counts,
      ]),
      h('div.panel-body.stack-sm', [
        h('div.log-toolbar', [
          fileSelect, levelSelect, searchInput,
          h('div.grow'),
          autoscrollBtn, pauseBtn,
          h('button.btn.is-sm', { onclick: load }, 'Reload'),
        ]),
      ]),
      h('div.panel-body.is-flush', { style: { padding: '0 var(--s-4) var(--s-4)' } }, viewport),
      h('div.panel-foot', 'Severity comes from the client\'s own message prefixes: [!!] critical, [-] error, [!] warning, [+] success, [=] info, [#] debug, [?] hint.'),
    ]),
  ]);

  loadFiles().then(load);

  return [view, () => socket.close()];
}
