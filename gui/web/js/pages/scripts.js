// Scripts — run the Lua, Cmd and Python scripts shipped with the client.

import { h, fill, leader, copyText, downloadText } from '../core/dom.js';
import { api, downloadUrl } from '../core/api.js';
import * as fmt from '../core/fmt.js';
import { loading, empty, errorState } from '../components/states.js';
import { reportError, toast } from '../core/notify.js';

const KIND_LABEL = { lua: 'Lua', cmd: 'Cmd', py: 'Python' };

export function mount({ params }) {
  const view = h('div.view');
  const listBody = h('div.list-scroll');
  const detailBody = h('div.panel-body');
  const outputBody = h('div.panel-body');
  const filterInput = h('input.input', {
    type: 'search', placeholder: 'Filter scripts…', 'aria-label': 'Filter scripts',
  });
  const kindFilter = h('div.btn-group');

  let allScripts = [];
  let selected = null;
  let activeKind = 'all';
  let running = false;

  function matches(script) {
    const query = filterInput.value.trim().toLowerCase();
    if (activeKind !== 'all' && script.kind !== activeKind) return false;
    if (!query) return true;
    return script.name.toLowerCase().includes(query)
      || (script.description || '').toLowerCase().includes(query);
  }

  function renderList() {
    const visible = allScripts.filter(matches);
    if (!visible.length) {
      fill(listBody, empty('No scripts match',
        allScripts.length ? 'Clear the filter to see every script.' : 'No script directories were found on this system.'));
      return;
    }
    fill(listBody, visible.map((script) => h('button.script-item', {
      'aria-current': String(selected?.absolute === script.absolute),
      onclick: () => select(script),
    }, [
      h('span.badge', KIND_LABEL[script.kind] || script.kind),
      h('span', [
        h('div.script-name', script.name),
        script.description ? h('div.script-desc.truncate', script.description) : null,
      ]),
      script.userOverride ? h('span.badge.is-warn', 'user') : h('span'),
    ])));
  }

  const argsInput = h('input.input', {
    type: 'text',
    placeholder: 'Optional arguments, e.g. -k FFFFFFFFFFFF',
    'aria-label': 'Script arguments',
  });

  function select(script) {
    selected = script;
    renderList();
    fill(detailBody, h('div.stack', [
      h('div.kv-grid', [
        leader('Name', script.name),
        leader('Language', KIND_LABEL[script.kind] || script.kind),
        leader('File', script.file),
        leader('Size', fmt.bytes(script.size)),
        leader('Modified', fmt.dateTime(script.modified)),
        leader('Author', script.author || null),
      ]),
      script.description ? h('p.hint', script.description) : null,
      h('div.field', [
        h('label', 'Arguments'),
        argsInput,
        h('p.hint', 'Appended to `script run <name>`. Letters, digits and . _ : , = / @ + - are accepted; anything else is rejected before the command is built.'),
      ]),
      h('div.row-wrap', [
        h('button.btn.is-primary', { onclick: () => run(script) }, 'Run script'),
        h('button.btn', { onclick: () => viewSource(script) }, 'View source'),
      ]),
      h('code.mono.faint', { style: { fontSize: 'var(--text-xs)' } }, script.absolute),
      h('p.hint', 'Scripts run inside the client with full access to the device. Read the source before running anything you did not write.'),
    ]));
  }

  async function run(script) {
    if (running) return;
    running = true;
    fill(outputBody, loading(`Running ${script.name}…`));
    try {
      const response = await api.runScript(script.name, argsInput.value, 300);
      const result = response.result;
      fill(outputBody, h('div.stack-sm', [
        h('div.row-wrap', [
          h('span.pill', { dataset: { state: result.ok ? 'success' : 'error' } },
            [h('span.dot'), result.ok ? 'Completed' : 'Reported errors']),
          h('span.faint.mono', { style: { fontSize: 'var(--text-xs)' } },
            `${result.command} · ${fmt.millis(result.duration)}${result.timedOut ? ' · timed out' : ''}`),
          h('button.btn.is-sm', {
            onclick: async () => {
              const okay = await copyText(result.output);
              toast(okay ? 'success' : 'error', okay ? 'Output copied' : 'Copy failed');
            },
          }, 'Copy'),
          h('button.btn.is-sm', {
            onclick: () => downloadText(`${script.name}-output.txt`, result.output),
          }, 'Download'),
        ]),
        h('pre.output', { style: { maxHeight: '34rem' } }, result.output || '(no output)'),
      ]));
    } catch (error) {
      fill(outputBody, errorState(error, { retry: () => run(script), title: 'Script failed' }));
    } finally {
      running = false;
    }
  }

  async function viewSource(script) {
    const rootByKind = { lua: 'luascripts', cmd: 'cmdscripts', py: 'pyscripts' };
    try {
      const response = await api.fileRead(rootByKind[script.kind], script.file);
      const { openModal } = await import('../components/modal.js');
      await openModal({
        title: script.file,
        wide: true,
        body: h('pre.output', { style: { maxHeight: '60vh' } }, response.text || '(binary file)'),
        actions: [
          { label: 'Download', run: (close) => { window.open(downloadUrl(rootByKind[script.kind], script.file)); close(null); } },
          { label: 'Close', primary: true, run: (close) => close(null) },
        ],
      });
    } catch (error) {
      reportError(error, 'Could not read the script');
    }
  }

  async function load() {
    fill(listBody, loading('Scanning script directories…'));
    try {
      const response = await api.scripts();
      allScripts = response.scripts;
      fill(kindFilter, [
        ['all', `All (${allScripts.length})`],
        ...Object.entries(response.counts).map(([kind, count]) => [kind, `${KIND_LABEL[kind]} (${count})`]),
      ].map(([kind, label]) => h('button.btn.is-sm', {
        class: kind === activeKind ? 'is-on' : '',
        onclick: (event) => {
          activeKind = kind;
          Array.from(kindFilter.children).forEach((button) => button.classList.remove('is-on'));
          event.currentTarget.classList.add('is-on');
          renderList();
        },
      }, label)));
      renderList();

      const preselect = params.get('select');
      if (preselect) {
        const found = allScripts.find((script) => script.name === preselect);
        if (found) select(found);
      }
    } catch (error) {
      fill(listBody, errorState(error, { retry: load }));
    }
  }

  filterInput.addEventListener('input', renderList);

  fill(view, [
    h('div.view-head', [
      h('div.titles', [
        h('h1.page-title', 'Scripts'),
        h('p.lede', 'Lua, Cmd and Python scripts the client can run. Files in ~/.proxmark3 take precedence over the ones shipped with the repository.'),
      ]),
      h('div.view-actions', [h('button.btn.is-sm', { onclick: load }, 'Rescan')]),
    ]),
    h('div.grid-split', [
      h('section.panel', [
        h('div.panel-head', [h('h2', 'Available scripts')]),
        h('div.panel-body.stack-sm', [filterInput, kindFilter]),
        listBody,
      ]),
      h('div.stack', [
        h('section.panel', [h('div.panel-head', [h('h2', 'Script detail')]), detailBody]),
        h('section.panel', [h('div.panel-head', [h('h2', 'Output')]), outputBody]),
      ]),
    ]),
  ]);

  fill(detailBody, empty('No script selected', 'Pick a script from the list to see its details and run it.'));
  fill(outputBody, h('p.hint', 'Script output appears here.'));
  load();

  return view;
}
