// Files — traces, dumps, dictionaries and resources on disk.
//
// Browsing is limited to the directories the client itself uses; the server
// resolves every path inside its root before reading anything.

import { h, fill, debounce, copyText } from '../core/dom.js';
import { api, downloadUrl } from '../core/api.js';
import * as fmt from '../core/fmt.js';
import { loading, empty, errorState } from '../components/states.js';
import { confirmAction } from '../components/modal.js';
import { icon } from '../components/icons.js';
import { toast, reportError } from '../core/notify.js';

export function mount({ params, router }) {
  const view = h('div.view');
  const rootRow = h('div.row-wrap');
  const crumbs = h('div.crumbs');
  const listBody = h('div.list-scroll');
  const previewBody = h('div.panel-body.file-preview');
  const filterInput = h('input.input', {
    type: 'search', placeholder: 'Filter this directory…', 'aria-label': 'Filter files',
    style: { maxWidth: '18rem' },
  });

  let roots = [];
  let currentRoot = params.get('root') || '';
  let currentPath = params.get('path') || '';
  let writable = new Set();

  async function loadRoots() {
    fill(rootRow, loading());
    try {
      const response = await api.fileRoots();
      roots = response.roots;
      writable = new Set(roots.filter((root) => root.writable).map((root) => root.name));
      if (!roots.length) {
        fill(rootRow, empty('No directories found',
          'None of the client\'s resource directories exist on this machine yet.'));
        return;
      }
      if (!currentRoot || !roots.some((root) => root.name === currentRoot)) {
        currentRoot = roots[0].name;
      }
      renderRoots();
      loadList();
    } catch (error) {
      fill(rootRow, errorState(error, { retry: loadRoots }));
    }
  }

  function renderRoots() {
    fill(rootRow, roots.map((root) => h('button.btn.is-sm', {
      class: root.name === currentRoot ? 'is-on' : '',
      title: root.path,
      onclick: () => {
        currentRoot = root.name;
        currentPath = '';
        renderRoots();
        loadList();
      },
    }, [root.name, h('span.faint', ` ${root.entries ?? ''}`)])));
  }

  function renderCrumbs() {
    const parts = currentPath ? currentPath.split('/').filter(Boolean) : [];
    const nodes = [h('button', {
      onclick: () => { currentPath = ''; loadList(); },
    }, currentRoot)];
    let accumulated = '';
    parts.forEach((part) => {
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      const target = accumulated;
      nodes.push(h('span.sep', '/'));
      nodes.push(h('button', { onclick: () => { currentPath = target; loadList(); } }, part));
    });
    fill(crumbs, nodes);
  }

  async function loadList() {
    renderCrumbs();
    fill(listBody, loading());
    try {
      const response = await api.fileList(currentRoot, currentPath, filterInput.value.trim());
      if (!response.entries.length) {
        fill(listBody, empty('Nothing here',
          filterInput.value ? 'No entries match the filter.' : 'This directory is empty.'));
        return;
      }
      fill(listBody, h('div.table-wrap', h('table.data', [
        h('thead', h('tr', [
          h('th', 'Name'), h('th', 'Kind'), h('th.num', 'Size'), h('th', 'Modified'), h('th', ''),
        ])),
        h('tbody', [
          currentPath
            ? h('tr.is-clickable', {
                onclick: () => {
                  const parent = currentPath.split('/').slice(0, -1).join('/');
                  currentPath = parent;
                  loadList();
                },
              }, [h('td.mono', '..'), h('td'), h('td'), h('td'), h('td')])
            : null,
          ...response.entries.map((entry) => h('tr.is-clickable', {
            onclick: () => (entry.isDir ? enter(entry) : preview(entry)),
          }, [
            h('td.mono', [
              h('span.file-row-icon', { style: { marginRight: '0.4rem' } },
                entry.isDir ? '▸' : '·'),
              entry.name,
            ]),
            h('td', h('span.badge', entry.kind)),
            h('td.num', entry.isDir ? '' : fmt.bytes(entry.size)),
            h('td.faint', fmt.ago(entry.modified)),
            h('td', h('div.row', { style: { gap: '0.25rem' } }, [
              entry.isDir ? null : h('a.btn.is-sm.is-ghost', {
                href: downloadUrl(currentRoot, entry.path),
                onclick: (event) => event.stopPropagation(),
                title: 'Download',
                download: entry.name,
              }, [icon('download', { size: 13 })]),
              (!entry.isDir && writable.has(currentRoot)) ? h('button.btn.is-sm.is-ghost', {
                onclick: (event) => { event.stopPropagation(); remove(entry); },
                title: 'Delete',
              }, [icon('trash', { size: 13 })]) : null,
            ])),
          ])),
        ].filter(Boolean)),
      ])));
    } catch (error) {
      fill(listBody, errorState(error, { retry: loadList }));
    }
  }

  function enter(entry) {
    currentPath = entry.path;
    loadList();
  }

  async function preview(entry) {
    fill(previewBody, loading(`Reading ${entry.name}…`));
    try {
      const response = await api.fileRead(currentRoot, entry.path);
      const actions = h('div.row-wrap', [
        h('a.btn.is-sm', { href: downloadUrl(currentRoot, entry.path), download: entry.name }, 'Download'),
        response.isText ? h('button.btn.is-sm', {
          onclick: async () => {
            const okay = await copyText(response.text || '');
            toast(okay ? 'success' : 'error', okay ? 'File copied' : 'Copy failed');
          },
        }, 'Copy') : null,
        ['.pm3', '.trace'].includes(entry.suffix) ? h('button.btn.is-sm.is-primary', {
          onclick: () => router.navigate('/signal'),
          title: 'Open the Signal page to load this into the graph buffer',
        }, 'Plot this trace') : null,
      ]);

      fill(previewBody, h('div.stack-sm', [
        h('div.spread', [
          h('span.mono', { style: { fontSize: 'var(--text-sm)' } }, entry.name),
          h('span.faint.mono', { style: { fontSize: 'var(--text-xs)' } },
            `${fmt.bytes(response.size)}${response.truncated ? ' · preview truncated' : ''}`),
        ]),
        actions,
        response.isText
          ? h('pre.output', { style: { maxHeight: '30rem' } }, response.text)
          : h('div.stack-sm', [
              h('p.hint', 'Binary file — showing the first bytes as hex.'),
              h('pre.output', { style: { maxHeight: '30rem' } }, formatHex(response.hex)),
            ]),
      ]));
    } catch (error) {
      fill(previewBody, errorState(error, { retry: () => preview(entry) }));
    }
  }

  function formatHex(hex) {
    if (!hex) return '(empty)';
    const rows = [];
    for (let i = 0; i < hex.length; i += 32) {
      const slice = hex.slice(i, i + 32);
      const bytes = slice.match(/../g) || [];
      const ascii = bytes.map((byte) => {
        const code = parseInt(byte, 16);
        return code >= 32 && code < 127 ? String.fromCharCode(code) : '.';
      }).join('');
      rows.push(`${(i / 2).toString(16).padStart(8, '0')}  ${bytes.join(' ').padEnd(47)}  ${ascii}`);
    }
    return rows.join('\n');
  }

  async function remove(entry) {
    const confirmed = await confirmAction({
      title: `Delete ${entry.name}`,
      message: `Permanently delete this file from ${currentRoot}?`,
      note: 'The file is removed from disk immediately. There is no undo.',
      confirmLabel: 'Delete file',
    });
    if (!confirmed) return;
    try {
      await api.fileDelete(currentRoot, entry.path);
      toast('success', 'File deleted', entry.name);
      loadList();
    } catch (error) {
      reportError(error, 'Could not delete the file');
    }
  }

  filterInput.addEventListener('input', debounce(loadList, 200));

  fill(view, [
    h('div.view-head', [
      h('div.titles', [
        h('h1.page-title', 'Files'),
        h('p.lede', 'The directories the client reads and writes: traces, dumps, dictionaries, scripts and resources.'),
      ]),
      h('div.view-actions', [filterInput]),
    ]),
    h('section.panel', [h('div.panel-body.stack-sm', [rootRow, crumbs])]),
    h('div.grid-split', { style: { gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)' } }, [
      h('section.panel', [h('div.panel-head', [h('h2', 'Directory')]), listBody]),
      h('section.panel', [h('div.panel-head', [h('h2', 'Preview')]), previewBody]),
    ]),
    h('p.hint', 'Only files inside these directories are reachable. Deleting is limited to your own ~/.proxmark3 directories; the repository copies are read-only here.'),
  ]);

  fill(previewBody, empty('No file selected', 'Choose a file to preview it, download it or plot it.'));
  loadRoots();

  return view;
}
