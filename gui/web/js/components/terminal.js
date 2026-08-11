// Terminal view for the live client stream.
//
// The client writes SGR colour, OSC-8 hyperlinks and `\r` in-place progress
// updates. This renders all three faithfully — colour as spans, hyperlinks as
// their label text, and a `\r` as a rewrite of the current line — while keeping
// the DOM bounded so a long `hf mf autopwn` cannot grow it without limit.

import { h, fill, copyText, downloadText } from '../core/dom.js';
import { icon } from './icons.js';

const MAX_LINES = 4000;

const SGR_COLOURS = {
  30: '#4d6169', 31: '#ff4d5e', 32: '#4ade80', 33: '#ffc53d',
  34: '#7aa7c7', 35: '#c08cf0', 36: '#3ee0d5', 37: '#d5e3e7',
  90: '#4d6169', 91: '#ff6b78', 92: '#6ee79a', 93: '#ffd668',
  94: '#93b9d4', 95: '#d0a6f5', 96: '#6ceae1', 97: '#f2fbfd',
};

/** Split raw text into styled runs. Returns [{ text, colour, bold }]. */
function tokenize(text, style) {
  const runs = [];
  let buffer = '';
  let index = 0;

  const flush = () => {
    if (buffer) {
      runs.push({ text: buffer, colour: style.colour, bold: style.bold });
      buffer = '';
    }
  };

  while (index < text.length) {
    const char = text[index];
    if (char !== '\x1b') { buffer += char; index += 1; continue; }

    // CSI ... final-byte
    const csi = /^\x1b\[([0-9;?]*)([ -/]*)([@-~])/.exec(text.slice(index));
    if (csi) {
      if (csi[3] === 'm') {
        flush();
        applySgr(style, csi[1]);
      }
      index += csi[0].length;
      continue;
    }
    // OSC ... BEL|ST — keep the visible label, drop the target.
    const osc = /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.exec(text.slice(index));
    if (osc) { index += osc[0].length; continue; }
    index += 1;
  }
  flush();
  return runs;
}

function applySgr(style, params) {
  const codes = (params || '0').split(';').map((value) => parseInt(value, 10) || 0);
  for (const code of codes) {
    if (code === 0) { style.colour = null; style.bold = false; }
    else if (code === 1) style.bold = true;
    else if (code === 22) style.bold = false;
    else if (code === 39) style.colour = null;
    else if (SGR_COLOURS[code]) style.colour = SGR_COLOURS[code];
  }
}

export function createTerminal({ onInput = null, onInterrupt = null, complete = null } = {}) {
  const screen = h('div.term-screen', { tabindex: '0', role: 'log', 'aria-label': 'Client output' });
  const style = { colour: null, bold: false };
  let currentLine = h('div.term-line');
  screen.appendChild(currentLine);

  let autoscroll = true;
  let paused = false;
  const pendingWhilePaused = [];
  let filterText = '';

  function trim() {
    while (screen.childElementCount > MAX_LINES) screen.removeChild(screen.firstChild);
  }

  function applyFilter(line) {
    if (!filterText) { line.hidden = false; return; }
    line.hidden = !line.textContent.toLowerCase().includes(filterText);
  }

  function write(text) {
    if (paused) {
      pendingWhilePaused.push(text);
      if (pendingWhilePaused.length > 500) pendingWhilePaused.shift();
      return;
    }
    const normalised = text.replace(/\r\n/g, '\n');
    for (const chunk of normalised.split('\n').entries()) {
      const [index, part] = chunk;
      if (index > 0) {
        applyFilter(currentLine);
        currentLine = h('div.term-line');
        screen.appendChild(currentLine);
        trim();
      }
      if (!part) continue;
      // A bare CR rewrites the line in place (spinners, progress counters).
      const segments = part.split('\r');
      segments.forEach((segment, i) => {
        if (i > 0) currentLine.replaceChildren();
        if (!segment) return;
        for (const run of tokenize(segment, style)) {
          if (!run.text) continue;
          const span = h('span', run.text);
          if (run.colour) span.style.color = run.colour;
          if (run.bold) span.style.fontWeight = '600';
          currentLine.appendChild(span);
        }
      });
      applyFilter(currentLine);
    }
    if (autoscroll) screen.scrollTop = screen.scrollHeight;
  }

  function clear() {
    screen.replaceChildren();
    currentLine = h('div.term-line');
    screen.appendChild(currentLine);
  }

  // --- controls -----------------------------------------------------------
  const filterInput = h('input.input.is-sm', {
    type: 'search',
    placeholder: 'Filter output…',
    'aria-label': 'Filter terminal output',
    style: { maxWidth: '14rem' },
    oninput: (event) => {
      filterText = event.target.value.trim().toLowerCase();
      Array.from(screen.children).forEach(applyFilter);
    },
  });

  const autoscrollBtn = h('button.btn.is-sm.is-on', {
    onclick: () => {
      autoscroll = !autoscroll;
      autoscrollBtn.classList.toggle('is-on', autoscroll);
      autoscrollBtn.setAttribute('aria-pressed', String(autoscroll));
      if (autoscroll) screen.scrollTop = screen.scrollHeight;
    },
    'aria-pressed': 'true',
    title: 'Follow new output',
  }, 'Follow');

  const pauseBtn = h('button.btn.is-sm', {
    onclick: () => {
      paused = !paused;
      pauseBtn.classList.toggle('is-on', paused);
      pauseBtn.setAttribute('aria-pressed', String(paused));
      fill(pauseBtn, paused ? 'Resume' : 'Pause');
      if (!paused) {
        pendingWhilePaused.splice(0).forEach(write);
      }
    },
    'aria-pressed': 'false',
    title: 'Pause the stream (output is buffered, not lost)',
  }, 'Pause');

  const controls = h('div.term-controls', [
    filterInput,
    h('div.grow'),
    autoscrollBtn,
    pauseBtn,
    h('button.btn.is-sm', {
      onclick: async () => {
        const okay = await copyText(screen.textContent);
        const { toast } = await import('../core/notify.js');
        toast(okay ? 'success' : 'error', okay ? 'Output copied' : 'Copy failed',
          okay ? '' : 'The browser blocked clipboard access.');
      },
      title: 'Copy all output',
    }, [icon('copy', { size: 14 })]),
    h('button.btn.is-sm', {
      onclick: () => downloadText(`pm3-console-${Date.now()}.log`, screen.textContent),
      title: 'Download output',
    }, [icon('download', { size: 14 })]),
    h('button.btn.is-sm', { onclick: clear, title: 'Clear the terminal view' }, 'Clear'),
  ]);

  // --- input line ---------------------------------------------------------
  const history = [];
  let historyIndex = -1;
  const suggestionBox = h('div.term-suggest', { hidden: true });

  const input = h('input.term-input', {
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Command input',
    placeholder: 'Type a command, e.g. hw version — Tab completes, ↑ recalls',
  });

  let suggestions = [];
  let suggestionIndex = -1;

  function hideSuggestions() {
    suggestions = [];
    suggestionIndex = -1;
    suggestionBox.hidden = true;
  }

  function showSuggestions(items) {
    suggestions = items;
    suggestionIndex = items.length ? 0 : -1;
    if (!items.length) { hideSuggestions(); return; }
    fill(suggestionBox, items.map((item, i) => h('button.term-suggest-item', {
      'aria-selected': String(i === suggestionIndex),
      onclick: () => { input.value = item; hideSuggestions(); input.focus(); },
    }, item)));
    suggestionBox.hidden = false;
  }

  input.addEventListener('keydown', async (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const value = input.value;
      if (!value.trim()) return;
      history.unshift(value);
      historyIndex = -1;
      input.value = '';
      hideSuggestions();
      onInput?.(value);
      return;
    }
    if (event.key === 'Tab' && complete) {
      event.preventDefault();
      if (suggestions.length && suggestionIndex >= 0) {
        input.value = suggestions[suggestionIndex];
        hideSuggestions();
        return;
      }
      const items = await complete(input.value);
      if (items.length === 1) { input.value = items[0]; hideSuggestions(); }
      else showSuggestions(items);
      return;
    }
    if (event.key === 'ArrowUp') {
      if (suggestions.length) {
        event.preventDefault();
        suggestionIndex = (suggestionIndex - 1 + suggestions.length) % suggestions.length;
        showSuggestions(suggestions);
        return;
      }
      if (historyIndex + 1 < history.length) {
        event.preventDefault();
        historyIndex += 1;
        input.value = history[historyIndex];
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      if (suggestions.length) {
        event.preventDefault();
        suggestionIndex = (suggestionIndex + 1) % suggestions.length;
        showSuggestions(suggestions);
        return;
      }
      if (historyIndex > 0) {
        historyIndex -= 1;
        input.value = history[historyIndex];
      } else if (historyIndex === 0) {
        historyIndex = -1;
        input.value = '';
      }
      return;
    }
    if (event.key === 'Escape') { hideSuggestions(); return; }
    if (event.key === 'c' && event.ctrlKey) {
      // Ctrl+C is muscle memory for "stop this", so it is mapped to the
      // client's real abort (Enter). Copying still works when text is selected.
      if (!window.getSelection()?.toString()) {
        event.preventDefault();
        onInterrupt?.();
      }
    }
  });

  const inputRow = h('div.term-input-row', [
    h('span.term-prompt.mono', 'pm3 ▸'),
    input,
    h('button.btn.is-sm.is-ghost', {
      onclick: () => onInterrupt?.(),
      title: 'Abort the running command. The client aborts on Enter — Ctrl+C '
        + 'would terminate it instead, so this sends Enter.',
    }, 'Abort'),
  ]);

  const node = h('div.term', [controls, screen, suggestionBox, inputRow]);

  return {
    node,
    write,
    clear,
    focus: () => input.focus(),
    setEnabled(enabled) {
      input.disabled = !enabled;
      input.placeholder = enabled
        ? 'Type a command, e.g. hw version — Tab completes, ↑ recalls'
        : 'Client is not running — start it from the Hardware page';
    },
  };
}
