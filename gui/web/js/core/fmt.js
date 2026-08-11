// Value formatting. Every helper returns an em dash for missing data so a gap in
// the instrument's output never renders as "0" or "undefined".

const DASH = '—';

export function bytes(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return DASH;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(value);
  let i = 0;
  while (Math.abs(n) >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function rate(bytesPerSecond) {
  if (bytesPerSecond === null || bytesPerSecond === undefined) return DASH;
  return `${bytes(bytesPerSecond)}/s`;
}

export function percent(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return DASH;
  return `${Number(value).toFixed(digits)}%`;
}

export function number(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return DASH;
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Compact duration: 4d 03h, 2h 14m, 3m 08s, 940ms. */
export function duration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return DASH;
  const total = Math.floor(Number(seconds));
  if (total < 1) return `${Math.round(Number(seconds) * 1000)}ms`;
  const d = Math.floor(total / 86400);
  const hrs = Math.floor((total % 86400) / 3600);
  const min = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (d) return `${d}d ${pad(hrs)}h`;
  if (hrs) return `${hrs}h ${pad(min)}m`;
  if (min) return `${min}m ${pad(sec)}s`;
  return `${sec}s`;
}

export function millis(seconds) {
  if (seconds === null || seconds === undefined) return DASH;
  const ms = Number(seconds) * 1000;
  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${Number(seconds).toFixed(2)} s`;
}

/** Wall clock from a unix timestamp (seconds). */
export function clock(ts) {
  if (!ts) return DASH;
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour12: false });
}

export function dateTime(ts) {
  if (!ts) return DASH;
  return new Date(ts * 1000).toLocaleString(undefined, { hour12: false });
}

/** "12s ago", "4m ago", "yesterday" — for activity feeds. */
export function ago(ts) {
  if (!ts) return DASH;
  const delta = Date.now() / 1000 - ts;
  if (delta < 5) return 'just now';
  if (delta < 60) return `${Math.floor(delta)}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

export function volts(value) {
  if (value === null || value === undefined) return DASH;
  return `${Number(value).toFixed(2)} V`;
}

export function frequency(khz) {
  if (khz === null || khz === undefined) return DASH;
  return khz >= 1000 ? `${(khz / 1000).toFixed(2)} MHz` : `${Number(khz).toFixed(2)} kHz`;
}

/** Severity -> the pill/meter state vocabulary used across the UI. */
export function levelState(level) {
  switch (level) {
    case 'success': return 'success';
    case 'warning': return 'warning';
    case 'error':
    case 'critical': return 'error';
    default: return 'idle';
  }
}

export function usageLevel(pct) {
  if (pct >= 90) return 'crit';
  if (pct >= 70) return 'warn';
  return 'ok';
}
