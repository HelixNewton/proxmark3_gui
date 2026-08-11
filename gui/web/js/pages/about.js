// About — versions, paths and what this interface is.

import { h, fill, leader } from '../core/dom.js';
import { api } from '../core/api.js';
import { store } from '../core/store.js';
import * as fmt from '../core/fmt.js';
import { loading, errorState } from '../components/states.js';
import * as shortcuts from '../core/shortcuts.js';

export function mount({ router }) {
  const view = h('div.view');
  const versionBody = h('div.panel-body');

  async function loadVersion() {
    fill(versionBody, loading());
    try {
      const response = await api.hwVersion();
      const client = response.version.client;
      fill(versionBody, h('div.kv-grid', [
        leader('Client', client.version),
        leader('Compiler', client.compiler),
        leader('Platform', client.platform),
        leader('Line editing', client.readline),
        leader('Qt plot window', client.qt),
        leader('Bluetooth', client.bluetooth),
        leader('Python scripting', client.python),
        leader('Lua scripting', client.lua),
      ]));
    } catch (error) {
      fill(versionBody, errorState(error, { retry: loadVersion }));
    }
  }

  const host = store.get('host');
  const catalog = store.get('catalog');
  const paths = store.get('paths');

  fill(view, [
    h('div.view-head', [
      h('div.titles', [
        h('h1.page-title', 'About'),
        h('p.lede', 'A web command centre for the Proxmark3 client. It drives the real client over a pseudo-terminal — every reading here comes from the instrument or the host.'),
      ]),
    ]),
    h('div.grid-2', [
      h('section.panel', [
        h('div.panel-head', [h('h2', 'Client')]),
        versionBody,
      ]),
      h('section.panel', [
        h('div.panel-head', [h('h2', 'Host')]),
        h('div.panel-body', h('div.kv-grid', [
          leader('Hostname', host.hostname),
          leader('System', host.system),
          leader('Architecture', host.machine),
          leader('Python', host.python),
          leader('CPU cores', host.cores ? `${host.cores} logical / ${host.physicalCores ?? '—'} physical` : null),
          leader('Host uptime', fmt.duration(host.uptime)),
          leader('Command catalogue', catalog.count ? `${catalog.count} commands` : null),
          leader('Catalogue source', catalog.source),
        ])),
      ]),
    ]),
    h('section.panel', [
      h('div.panel-head', [h('h2', 'Directories in use')]),
      h('div.panel-body', h('div.stack-sm',
        Object.entries(paths).map(([name, path]) => leader(name, path)))),
      h('div.panel-foot', 'These follow the layout described in doc/path_notes.md. Files in ~/.proxmark3 take precedence over the copies in the repository.'),
    ]),
    h('div.grid-2', [
      h('section.panel', [
        h('div.panel-head', [h('h2', 'Keyboard shortcuts')]),
        h('div.panel-body', h('div.stack-sm', shortcuts.list().map((binding) => h('div.leader', [
          h('span.leader-key', binding.description),
          h('span.leader-fill'),
          h('span.leader-value', h('kbd', shortcuts.chord(binding))),
        ])))),
      ]),
      h('section.panel', [
        h('div.panel-head', [h('h2', 'Project')]),
        h('div.panel-body.stack-sm', [
          h('p', 'The Proxmark3 is an RFID research instrument. This interface wraps the Iceman fork\'s client without replacing it: the same binary, the same preferences file, the same logs.'),
          h('p.hint', 'The client remains fully usable from a terminal — run ./pm3 in the repository root. Anything this interface can do, it does by issuing the same commands you would type there.'),
          h('div.stack-sm', [
            h('div.eyebrow', 'Links'),
            h('a', { href: 'https://github.com/RfidResearchGroup/proxmark3', target: '_blank', rel: 'noreferrer noopener' }, 'RfidResearchGroup/proxmark3 on GitHub'),
            h('button.btn.is-sm', { onclick: () => router.navigate('/commands') }, 'Browse the command reference'),
          ]),
        ]),
      ]),
    ]),
  ]);

  loadVersion();
  return view;
}
