// Minimal DOM construction helpers.
//
// The interface builds elements directly rather than templating strings: nothing
// user- or device-supplied is ever parsed as HTML, which removes an entire class
// of injection bugs in a tool whose whole job is displaying untrusted tag data.

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('div.panel', {onclick}, [children]) -> HTMLElement
 * Tag supports `tag.class1.class2#id` shorthand.
 */
export function h(tag, props = null, children = null) {
  if (Array.isArray(props) || typeof props === 'string' || props instanceof Node) {
    children = props;
    props = null;
  }
  const { name, classes, id } = parseTag(tag);
  const el = document.createElement(name);
  if (classes.length) el.className = classes.join(' ');
  if (id) el.id = id;
  applyProps(el, props);
  append(el, children);
  return el;
}

/** SVG-namespaced variant; required for icons and charts. */
export function s(tag, props = null, children = null) {
  const { name, classes } = parseTag(tag);
  const el = document.createElementNS(SVG_NS, name);
  if (classes.length) el.setAttribute('class', classes.join(' '));
  applyProps(el, props, true);
  append(el, children);
  return el;
}

function parseTag(tag) {
  const [head, id] = String(tag).split('#');
  const parts = head.split('.');
  return { name: parts[0] || 'div', classes: parts.slice(1), id };
}

function applyProps(el, props, isSvg = false) {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') {
      const existing = isSvg ? el.getAttribute('class') : el.className;
      const merged = [existing, value].filter(Boolean).join(' ');
      isSvg ? el.setAttribute('class', merged) : (el.className = merged);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(el.style, value);
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) {
        if (v !== null && v !== undefined) el.dataset[k] = v;
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (!isSvg && key in el && key !== 'list' && key !== 'form') {
      el[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

function append(el, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) {
    children.forEach((child) => append(el, child));
    return;
  }
  el.appendChild(children instanceof Node ? children : document.createTextNode(String(children)));
}

/** Replace an element's children in one operation. */
export function fill(target, children) {
  target.replaceChildren();
  append(target, children);
  return target;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/** A dotted-leader data row — the interface's primary label/value idiom. */
export function leader(key, value, opts = {}) {
  const cls = opts.level ? `div.leader.is-${opts.level}` : 'div.leader';
  return h(cls, opts.title ? { title: opts.title } : null, [
    h('span.leader-key', String(key)),
    h('span.leader-fill', { 'aria-hidden': 'true' }),
    h('span.leader-value', { class: opts.valueClass }, value === null || value === undefined || value === ''
      ? h('span.faint', '—')
      : String(value)),
  ]);
}

/** Small caps label used above groups of readouts. */
export function eyebrow(text) {
  return h('div.eyebrow', String(text));
}

/** Debounce for search inputs and resize handlers. */
export function debounce(fn, wait = 200) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/** Copy text, returning whether it worked so callers can report honestly. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    try {
      const area = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
      document.body.appendChild(area);
      area.select();
      const okay = document.execCommand('copy');
      area.remove();
      return okay;
    } catch {
      return false;
    }
  }
}

/** Trigger a client-side file download from a string. */
export function downloadText(filename, text, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = h('a', { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
