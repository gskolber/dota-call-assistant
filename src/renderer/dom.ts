// Tiny hyperscript. The screens rebuild their subtree every tick, so the
// helper only has to be fast to write, not clever.

type Child = Node | string | number | false | null | undefined | Child[];

export interface Props {
  class?: string;
  text?: string | number;
  html?: string;
  title?: string;
  style?: string;
  onClick?: (event: MouseEvent) => void;
  onInput?: (event: Event) => void;
  onChange?: (event: Event) => void;
  data?: Record<string, string>;
  attrs?: Record<string, string | number | boolean | null>;
}

/** `h('div.row.row--wide', props, …children)` */
export function h<K extends keyof HTMLElementTagNameMap>(
  selector: K | `${K}.${string}`,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = selector.split('.');
  const el = document.createElement(tag as K);

  const className = [...classes, props.class ?? ''].filter(Boolean).join(' ');
  if (className) el.className = className;
  if (props.text !== undefined) el.textContent = String(props.text);
  if (props.html !== undefined) el.innerHTML = props.html;
  if (props.title) el.title = props.title;
  if (props.style) el.setAttribute('style', props.style);
  if (props.onClick) el.addEventListener('click', props.onClick as EventListener);
  if (props.onInput) el.addEventListener('input', props.onInput);
  if (props.onChange) el.addEventListener('change', props.onChange);
  for (const [key, value] of Object.entries(props.data ?? {})) el.dataset[key] = value;
  for (const [key, value] of Object.entries(props.attrs ?? {})) {
    if (value === null || value === false) continue;
    el.setAttribute(key, String(value));
  }

  append(el, children);
  return el;
}

function append(parent: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

export function clear(node: HTMLElement): HTMLElement {
  node.replaceChildren();
  return node;
}

export function mount(node: HTMLElement, ...children: Child[]): HTMLElement {
  clear(node);
  append(node, children);
  return node;
}
