// Global keyboard shortcuts.
//
// Bindings never fire while the operator is typing into a field or the terminal —
// pressing "r" mid-command must not reload the page.

const registry = [];

export function register(binding) {
  registry.push(binding);
  return () => {
    const index = registry.indexOf(binding);
    if (index >= 0) registry.splice(index, 1);
  };
}

/** Bindings worth showing in the shortcut sheet. */
export function list() {
  return registry.filter((binding) => Boolean(binding.description));
}

function isTyping(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function matches(binding, event) {
  if (binding.key.toLowerCase() !== event.key.toLowerCase()) return false;
  const wantsMod = Boolean(binding.mod);
  const hasMod = event.metaKey || event.ctrlKey;
  if (wantsMod !== hasMod) return false;
  if (Boolean(binding.shift) !== event.shiftKey) return false;
  return true;
}

export function install() {
  window.addEventListener('keydown', (event) => {
    // Escape must work even from inside a field so dialogs can always close.
    if (isTyping(event.target) && event.key !== 'Escape' && !(event.metaKey || event.ctrlKey)) {
      return;
    }
    for (const binding of registry) {
      if (!matches(binding, event)) continue;
      if (binding.whenTyping === false && isTyping(event.target)) continue;
      event.preventDefault();
      binding.run(event);
      return;
    }
  });
}

/** Human-readable chord, e.g. "Ctrl K" / "⌘ K" on Apple platforms. */
export function chord(binding) {
  const isApple = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const parts = [];
  if (binding.mod) parts.push(isApple ? '⌘' : 'Ctrl');
  if (binding.shift) parts.push('Shift');
  parts.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return parts.join(' ');
}
