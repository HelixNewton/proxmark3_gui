// Hash router. Each route owns a mount function that returns an element and an
// optional teardown, so pages can stop timers and sockets when they leave.

export class Router extends EventTarget {
  constructor(outlet) {
    super();
    this.outlet = outlet;
    this.routes = new Map();
    this.current = null;
    this.teardown = null;
    window.addEventListener('hashchange', () => this.resolve());
  }

  register(path, definition) {
    this.routes.set(path, definition);
    return this;
  }

  get routeList() {
    return Array.from(this.routes.entries()).map(([path, def]) => ({ path, ...def }));
  }

  /** "#/logs?file=log_1.txt" -> { path: '/logs', params: URLSearchParams } */
  static parse(hash) {
    const raw = (hash || location.hash || '#/').replace(/^#/, '') || '/';
    const [path, search] = raw.split('?');
    return { path: path || '/', params: new URLSearchParams(search || '') };
  }

  navigate(path, params = null) {
    const search = params ? `?${new URLSearchParams(params)}` : '';
    const next = `#${path}${search}`;
    if (location.hash === next) this.resolve();
    else location.hash = next;
  }

  async resolve() {
    const { path, params } = Router.parse(location.hash);
    const definition = this.routes.get(path) || this.routes.get('/');
    if (!definition) return;

    if (this.teardown) {
      try { this.teardown(); } catch { /* a failing teardown must not block nav */ }
      this.teardown = null;
    }

    this.current = { path, definition, params };
    document.title = `${definition.title} · PM3 Command Centre`;
    this.dispatchEvent(new CustomEvent('navigate', { detail: this.current }));

    this.outlet.replaceChildren();
    let view;
    try {
      view = await definition.mount({ params, router: this });
    } catch (error) {
      console.error('Route mount failed', error);
      this.dispatchEvent(new CustomEvent('error', { detail: { path, error } }));
      return;
    }
    if (!view) return;
    const [element, teardown] = Array.isArray(view) ? view : [view, null];
    this.teardown = teardown;
    this.outlet.replaceChildren(element);
    // Move focus to the new view for screen-reader and keyboard users.
    this.outlet.focus({ preventScroll: true });
    this.outlet.scrollTop = 0;
  }
}
