// Accessible dialogs built on <dialog>: focus trapping, Escape and backdrop
// dismissal come from the platform.

import { h, fill } from '../core/dom.js';

/** Open a dialog; resolves with whatever the caller passes to `close(value)`. */
export function openModal({ title, body, actions = [], danger = false, wide = false }) {
  return new Promise((resolve) => {
    const dialog = h(`dialog.modal${danger ? '.is-danger' : ''}`, {
      'aria-labelledby': 'modal-title',
      style: wide ? { maxWidth: 'min(72rem, 96vw)' } : null,
    });

    const close = (value) => {
      dialog.close();
      resolve(value);
    };

    fill(dialog, [
      h('div.modal-head', [
        h('h2#modal-title', title),
        h('button.btn.is-ghost.is-sm', { onclick: () => close(null), 'aria-label': 'Close dialog' }, '✕'),
      ]),
      h('div.modal-body', typeof body === 'function' ? body(close) : body),
      actions.length
        ? h('div.modal-foot', actions.map((action) => h(
            `button.btn${action.primary ? '.is-primary' : ''}${action.danger ? '.is-danger' : ''}`,
            { onclick: () => (action.run ? action.run(close) : close(action.value)) },
            action.label,
          )))
        : null,
    ]);

    document.body.appendChild(dialog);
    dialog.addEventListener('close', () => { dialog.remove(); resolve(null); }, { once: true });
    // Clicking the backdrop (outside the dialog box) cancels.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) close(null);
    });
    dialog.showModal();
  });
}

/**
 * Confirmation gate for destructive actions. States plainly what will happen —
 * the note comes from the server so the wording matches the real consequence.
 */
export function confirmAction({ title, message, note = null, confirmLabel = 'Confirm', danger = true }) {
  return openModal({
    title,
    danger,
    body: h('div.stack', [
      h('p', message),
      note ? h('div.panel', { style: { padding: 'var(--s-3)', borderColor: 'var(--err)' } },
        h('p.mono', { style: { fontSize: 'var(--text-sm)', color: 'var(--err)' } }, note)) : null,
    ]),
    actions: [
      { label: 'Cancel', run: (close) => close(false) },
      { label: confirmLabel, danger, run: (close) => close(true) },
    ],
  }).then((value) => value === true);
}

/** Read-only viewer for raw client output, with copy. */
export function showOutput(title, text, { copy = true } = {}) {
  return openModal({
    title,
    wide: true,
    body: h('pre.output', { style: { maxHeight: '60vh' } }, text || '(no output)'),
    actions: [
      copy ? {
        label: 'Copy output',
        run: async (close) => {
          const { copyText } = await import('../core/dom.js');
          await copyText(text || '');
          close(true);
        },
      } : null,
      { label: 'Close', primary: true, run: (close) => close(null) },
    ].filter(Boolean),
  });
}
