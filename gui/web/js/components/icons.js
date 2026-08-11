// Inline SVG icon set. Drawn on a 24-unit grid with a 1.6 stroke so they sit at
// the same optical weight as the monospace type around them.

import { s } from '../core/dom.js';

const PATHS = {
  dashboard: ['M3 13h6V3H3zM13 21h8V11h-8zM13 7h8V3h-8zM3 21h6v-6H3z'],
  antenna: ['M12 22V9', 'M6.5 13a7 7 0 0 1 11 0', 'M3.5 16a11 11 0 0 1 17 0', 'M12 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  scan: ['M3 8V5a2 2 0 0 1 2-2h3', 'M16 3h3a2 2 0 0 1 2 2v3', 'M21 16v3a2 2 0 0 1-2 2h-3', 'M8 21H5a2 2 0 0 1-2-2v-3', 'M3 12h18'],
  wave: ['M2 12h3l2-7 3 14 3-11 2.5 8 2-4H22'],
  chip: ['M8 8h8v8H8z', 'M4 9V6a2 2 0 0 1 2-2h3', 'M15 4h3a2 2 0 0 1 2 2v3', 'M20 15v3a2 2 0 0 1-2 2h-3', 'M9 20H6a2 2 0 0 1-2-2v-3'],
  trace: ['M3 17l5-5 4 3 5-7 4 4', 'M3 21h18'],
  script: ['M8 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z', 'M14 3v6h6', 'M8 13h8', 'M8 17h5'],
  terminal: ['M4 4h16v16H4z', 'M8 9l3 3-3 3', 'M13 15h4'],
  logs: ['M4 4h16v16H4z', 'M8 8h8', 'M8 12h8', 'M8 16h5'],
  book: ['M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z', 'M8 3v18'],
  files: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 16v-5', 'M12 8h.01'],
  bell: ['M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.7 21a2 2 0 0 1-3.4 0'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
  rail: ['M4 5h16', 'M4 12h16', 'M4 19h16'],
  refresh: ['M21 12a9 9 0 1 1-3-6.7', 'M21 4v5h-5'],
  play: ['M6 4l14 8-14 8z'],
  stop: ['M6 6h12v12H6z'],
  power: ['M12 3v9', 'M18.4 6.6a9 9 0 1 1-12.8 0'],
  download: ['M12 3v12', 'M7 11l5 5 5-5', 'M4 21h16'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  chevron: ['M9 6l6 6-6 6'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  plug: ['M9 3v6', 'M15 3v6', 'M6 9h12v3a6 6 0 0 1-12 0z', 'M12 18v3'],
  pause: ['M7 5h3v14H7z', 'M14 5h3v14h-3z'],
};

export function icon(name, { size = 20, className = 'ico' } = {}) {
  const paths = PATHS[name] || PATHS.info;
  return s('svg', {
    class: className,
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.6,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }, paths.map((d) => s('path', { d })));
}

/** Brand mark: a resonant coil — the instrument's defining component. */
export function brandMark() {
  return s('svg.rail-mark', {
    viewBox: '0 0 32 32', fill: 'none', 'aria-hidden': 'true',
    stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round',
  }, [
    s('rect', { x: 3.5, y: 3.5, width: 25, height: 25, rx: 1, stroke: 'currentColor', opacity: 0.35 }),
    s('path', { d: 'M8 16h3l2-6 3 12 3-9 2 5 3-2h2' }),
    s('circle', { cx: 16, cy: 16, r: 11.5, opacity: 0.18 }),
  ]);
}
