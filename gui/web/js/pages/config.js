// Configuration — client preferences, edited through `prefs set`.
//
// Changes are written by the client itself into ~/.proxmark3/preferences.json, so
// the GUI and a terminal session always agree. Nothing is applied until the
// operator commits it; the current value is shown next to every control.

import { h, fill, leader } from '../core/dom.js';
import { api } from '../core/api.js';
import { store, loadPref, savePref } from '../core/store.js';
import { loading, errorState, empty } from '../components/states.js';
import { toast, reportError } from '../core/notify.js';

export function mount({ router }) {
  const view = h('div.view');
  const settingsBody = h('div');
  const currentBody = h('div.panel-body');
  const rawBody = h('div.panel-body');

  let specs = {};
  let currentValues = {};

  async function load() {
    fill(settingsBody, loading('Reading client preferences…'));
    fill(currentBody, loading());
    try {
      const response = await api.prefs();
      specs = response.specs;
      currentValues = {};
      (response.prefs.prefs || []).forEach((pref) => { currentValues[pref.key] = pref.value; });
      renderSettings(response);
      renderCurrent(response);
      renderRaw(response);
    } catch (error) {
      fill(settingsBody, errorState(error, { retry: load }));
      fill(currentBody, h('div'));
    }
  }

  /** `prefs show` labels differ from `prefs set` keys; map them for display. */
  const LABEL_FOR_KEY = {
    color: 'color',
    emoji: 'emoji',
    hints: 'hints',
    output: 'output',
    plotsliders: 'show plot sliders',
    'client.debug': 'client debug',
    'client.delay': 'cmd execution delay',
    'client.timeout': 'communication timeout',
    'hf.field.timeout_sec': 'HF field timeout',
  };

  function currentFor(key) {
    const label = LABEL_FOR_KEY[key];
    return label ? currentValues[label] : undefined;
  }

  function renderSettings() {
    const groups = {};
    Object.entries(specs).forEach(([key, spec]) => {
      (groups[spec.group] ||= []).push([key, spec]);
    });

    fill(settingsBody, Object.entries(groups).map(([groupName, items]) => h('section.panel', [
      h('div.panel-head', [h('h2', groupName)]),
      h('div', items.map(([key, spec]) => renderSetting(key, spec))),
    ])));
  }

  function renderSetting(key, spec) {
    const current = currentFor(key);
    let control;

    if (spec.type === 'choice') {
      control = h('div.btn-group', { style: { flexWrap: 'wrap' } },
        spec.choices.map((choice) => h('button.btn.is-sm', {
          class: matchesCurrent(choice, current) ? 'is-on' : '',
          onclick: () => apply(key, choice.value, `${spec.label} → ${choice.label}`),
        }, choice.label)));
    } else {
      const input = h('input.input', {
        type: 'number',
        min: spec.min, max: spec.max,
        value: parseInt(String(current ?? '0'), 10) || 0,
        'aria-label': spec.label,
      });
      const error = h('p.error', { hidden: true });
      control = h('div.stack-sm', [
        h('div.row', [
          input,
          h('span.faint.mono', { style: { fontSize: 'var(--text-xs)' } }, spec.unit),
          h('button.btn.is-sm.is-primary', {
            onclick: () => {
              const value = Number(input.value);
              if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
                error.hidden = false;
                fill(error, `Enter a whole number between ${spec.min} and ${spec.max}.`);
                input.setAttribute('aria-invalid', 'true');
                return;
              }
              error.hidden = true;
              input.removeAttribute('aria-invalid');
              apply(key, value, `${spec.label} → ${value} ${spec.unit}`);
            },
          }, 'Apply'),
        ]),
        error,
      ]);
    }

    return h('div.setting', [
      h('div', [
        h('div.setting-label', spec.label),
        h('div.setting-help', spec.help),
        h('div.setting-current', `prefs set ${key} · currently: ${current ?? 'unknown'}`),
      ]),
      control,
    ]);
  }

  function matchesCurrent(choice, current) {
    if (current === undefined || current === null) return false;
    const normalised = String(current).trim().toLowerCase();
    const label = choice.label.toLowerCase();
    const flag = choice.value.replace(/^-+/, '').toLowerCase();
    return normalised === label || normalised === flag
      || (flag === 'off' && normalised === 'off')
      || (flag === 'on' && normalised === 'on');
  }

  async function apply(key, value, description) {
    try {
      const response = await api.setPref(key, value);
      if (!response.result.ok) {
        toast('warning', 'The client rejected the change', response.result.output.split('\n')[0] || '');
      } else {
        toast('success', 'Preference saved', description);
      }
      load();
    } catch (error) {
      reportError(error, 'Could not change the preference');
    }
  }

  function renderCurrent(response) {
    const prefs = response.prefs.prefs || [];
    if (!prefs.length) {
      fill(currentBody, empty('No preferences reported',
        'The client returned no settings. Check the raw output below.'));
      return;
    }
    fill(currentBody, h('div.kv-grid', prefs.map((pref) => leader(pref.key, pref.value))));
  }

  function renderRaw(response) {
    fill(rawBody, h('div.stack-sm', [
      h('p.hint', `Written by the client to ${response.file}. This is the file a terminal session reads too.`),
      h('pre.output', { style: { maxHeight: '24rem' } },
        response.rawFile ? JSON.stringify(response.rawFile, null, 2) : '(preferences file not created yet)'),
    ]));
  }

  /* ------------------------------------------------------- GUI-only prefs */
  const guiBody = h('div');
  function renderGuiSettings() {
    const density = loadPref('pm3gui.density', 'comfortable');
    fill(guiBody, [
      h('div.setting', [
        h('div', [
          h('div.setting-label', 'Sidebar'),
          h('div.setting-help', 'Collapse the navigation rail to icons only. Ctrl+B toggles it from anywhere.'),
        ]),
        h('div.btn-group', [
          h('button.btn.is-sm', {
            class: store.get('railCollapsed') ? '' : 'is-on',
            onclick: () => { store.setRail(false); renderGuiSettings(); },
          }, 'Expanded'),
          h('button.btn.is-sm', {
            class: store.get('railCollapsed') ? 'is-on' : '',
            onclick: () => { store.setRail(true); renderGuiSettings(); },
          }, 'Collapsed'),
        ]),
      ]),
      h('div.setting', [
        h('div', [
          h('div.setting-label', 'Reduced motion'),
          h('div.setting-help', 'This interface already honours your operating system\'s reduced-motion setting. Animations are disabled automatically when it is on.'),
        ]),
        h('div', h('span.pill', {
          dataset: { state: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'active' : 'idle' },
        }, [h('span.dot'),
          window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'Reduced' : 'Full motion'])),
      ]),
      h('div.setting', [
        h('div', [
          h('div.setting-label', 'Clear notification history'),
          h('div.setting-help', 'Empties the notification centre in this browser and on the server.'),
        ]),
        h('div', h('button.btn.is-sm', {
          onclick: async () => {
            try {
              await api.clearNotifications();
              store.patch({ notifications: [], unread: 0 });
              toast('success', 'Notifications cleared');
            } catch (error) { reportError(error, 'Could not clear notifications'); }
          },
        }, 'Clear')),
      ]),
    ]);
  }

  fill(view, [
    h('div.view-head', [
      h('div.titles', [
        h('h1.page-title', 'Configuration'),
        h('p.lede', 'Client preferences are stored by the client itself, so changes here apply to terminal sessions too.'),
      ]),
      h('div.view-actions', [h('button.btn.is-sm', { onclick: load }, 'Reload')]),
    ]),
    settingsBody,
    h('section.panel', [
      h('div.panel-head', [h('h2', 'Interface')]),
      guiBody,
    ]),
    h('div.grid-2', [
      h('section.panel', [
        h('div.panel-head', [h('h2', 'All current settings')]),
        currentBody,
      ]),
      h('section.panel', [
        h('div.panel-head', [h('h2', 'preferences.json')]),
        rawBody,
      ]),
    ]),
    h('p.hint', 'Settings the GUI does not expose — window geometry for the legacy Qt plot, MQTT and save paths — remain editable from the client with `prefs set`. They are listed above so you can see their current values.'),
  ]);

  renderGuiSettings();
  load();

  return view;
}
