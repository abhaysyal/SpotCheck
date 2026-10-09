// Builders for the framework internals component-probe.js reads.
//
// These mirror the real shapes rather than the probe's expectations, so a
// test failing here means the probe is wrong about a framework, not that a
// fixture was written to match the implementation. Shapes verified against
// the actual dev builds during Feature 9's live verification: React 18.3.1
// (react-dom's `_debugSource = element._source`, memo as `{ type }`,
// forwardRef as `{ render }`) and Vue 3.5 (`def(el, "__vueParentComponent")`,
// SFCs compiling to `__name` + `__file`).

/** React attaches its fiber under a randomly-suffixed key. */
export function attachReactFiber(element, fiber) {
  element[`__reactFiber$${Math.random().toString(36).slice(2, 8)}`] = fiber;
  return element;
}

/** A function component. `displayName` wins over `name` in the probe. */
export function reactComponent(name, { displayName } = {}) {
  const fn = new Function(`return function ${name}(){}`)();
  if (displayName) fn.displayName = displayName;
  return fn;
}

/** React.memo(inner) — the wrapper the probe has to unwrap via `.type`. */
export function memo(inner) {
  return { $$typeof: Symbol.for("react.memo"), type: inner, compare: null };
}

/** React.forwardRef(fn) — unwrapped via `.render`. */
export function forwardRef(render) {
  return { $$typeof: Symbol.for("react.forward_ref"), render };
}

/**
 * Build a fiber chain from innermost outward. Each entry is
 * `{ type, file, line }`; `type` may be a function or a memo/forwardRef
 * wrapper. Returns the innermost fiber, with `.return` linking upward the
 * way react-dom does.
 */
export function reactFiberChain(entries) {
  let parent = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const { type, file, line } = entries[i];
    const fiber = {
      type,
      return: parent,
      _debugSource: file ? { fileName: file, lineNumber: line ?? 1 } : null,
      _debugOwner: null,
    };
    parent = fiber;
  }
  return parent;
}

/** Makes reactIsPresent() true without a fiber anywhere. */
export function installReactDevtoolsHook(window) {
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { renderers: new Map([[1, {}]]) };
}

/** Vue 3: el.__vueParentComponent, walking up via `.parent`. */
export function attachVue3(element, entries) {
  let parent = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const { name, file } = entries[i];
    parent = { type: { __name: name, __file: file }, parent };
  }
  element.__vueParentComponent = parent;
  return element;
}

/** Vue 2: el.__vue__, walking up via `$parent`. */
export function attachVue2(element, entries) {
  let parent = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const { name, file, tag } = entries[i];
    parent = { $options: { name, __file: file, _componentTag: tag }, $parent: parent };
  }
  element.__vue__ = parent;
  return element;
}

/** Svelte dev builds stamp the source location straight onto the node. */
export function attachSvelteMeta(element, { file, line }) {
  element.__svelte_meta = { loc: { file, line } };
  return element;
}

/**
 * Angular's global debug API. `components` maps an element to the component
 * instance that owns it, which is what ng.getComponent returns.
 */
export function installAngular(window, components) {
  window.ng = {
    getComponent: (el) => components.get(el) || null,
    getOwningComponent: () => null,
  };
}

/** A class whose `.name` is what the probe reports for Angular. */
export function angularComponentInstance(className) {
  const Ctor = new Function(`return class ${className} {}`)();
  return new Ctor();
}
