// What the elements share: a base class that a server can import without a
// DOM (a framework's server render loads the module but never runs it), a
// small element builder, and the theme as CSS custom properties a page can
// override (`--orgasm-hud-accent: …` on the element or any ancestor).

/** HTMLElement in a browser; an inert class where there is none, so importing is safe anywhere. */
export const ElementBase: typeof HTMLElement = (typeof HTMLElement === 'undefined' ? class {} : HTMLElement) as typeof HTMLElement;

type Child = Node | string | null | undefined | false;

/** An element with attributes (`class`, `aria-*`, `data-*`, …) and children. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | number | boolean | null | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: SVGElement[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  for (const child of children) el.append(child);
  return el;
}

/** Set an element's text only when it changed, so a once-a-second render touches nothing that did not. */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/** The theme: dark by default, light on request or when the page prefers it with `theme="auto"`. */
export const THEME_CSS = `
:host {
  --hud-accent: var(--orgasm-hud-accent, #fa7f8c);
  --hud-ghost: var(--orgasm-hud-ghost, #f5c26b);
  --hud-on: var(--orgasm-hud-on, #7de2c3);
  --hud-warn: var(--orgasm-hud-warn, #f5c26b);
  --hud-surface: var(--orgasm-hud-surface, rgb(14 11 16 / 0.88));
  --hud-text: var(--orgasm-hud-text, #f4eef2);
  --hud-muted: var(--orgasm-hud-muted, rgb(244 238 242 / 0.64));
  --hud-line: var(--orgasm-hud-line, rgb(244 238 242 / 0.14));
  --hud-track: var(--orgasm-hud-track, rgb(244 238 242 / 0.12));
  --hud-radius: var(--orgasm-hud-radius, 16px);
  --hud-font: var(--orgasm-hud-font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  --hud-mono: var(--orgasm-hud-mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
  color-scheme: dark;
  font-family: var(--hud-font);
  color: var(--hud-text);
  -webkit-font-smoothing: antialiased;
}
:host([theme="light"]) {
  --hud-accent: var(--orgasm-hud-accent, #cb304f);
  --hud-ghost: var(--orgasm-hud-ghost, #b7791f);
  --hud-on: var(--orgasm-hud-on, #0f8a6a);
  --hud-warn: var(--orgasm-hud-warn, #a4630b);
  --hud-surface: var(--orgasm-hud-surface, rgb(255 255 255 / 0.94));
  --hud-text: var(--orgasm-hud-text, #17121a);
  --hud-muted: var(--orgasm-hud-muted, rgb(23 18 26 / 0.62));
  --hud-line: var(--orgasm-hud-line, rgb(23 18 26 / 0.12));
  --hud-track: var(--orgasm-hud-track, rgb(23 18 26 / 0.1));
  color-scheme: light;
}
@media (prefers-color-scheme: light) {
  :host([theme="auto"]) {
    --hud-accent: var(--orgasm-hud-accent, #cb304f);
    --hud-ghost: var(--orgasm-hud-ghost, #b7791f);
    --hud-on: var(--orgasm-hud-on, #0f8a6a);
    --hud-warn: var(--orgasm-hud-warn, #a4630b);
    --hud-surface: var(--orgasm-hud-surface, rgb(255 255 255 / 0.94));
    --hud-text: var(--orgasm-hud-text, #17121a);
    --hud-muted: var(--orgasm-hud-muted, rgb(23 18 26 / 0.62));
    --hud-line: var(--orgasm-hud-line, rgb(23 18 26 / 0.12));
    --hud-track: var(--orgasm-hud-track, rgb(23 18 26 / 0.1));
    color-scheme: light;
  }
}
:host([hidden]) { display: none !important; }
/* An element's own display (grid, flex) must never override its hidden attribute. */
[hidden] { display: none !important; }
*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; color: inherit; }
button:focus-visible, a:focus-visible { outline: 2px solid var(--hud-accent); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
`;

/** Define a custom element once, and only where there is a registry. */
export function define(name: string, constructor: CustomElementConstructor): void {
  if (typeof customElements === 'undefined' || customElements.get(name)) return;
  customElements.define(name, constructor);
}
