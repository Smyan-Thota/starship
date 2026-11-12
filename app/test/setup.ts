/**
 * Puts a happy-dom window on globalThis so React and DOMPurify can run under `bun test`.
 * Preloaded by app/bunfig.toml. render.test.tsx also imports it, so a run from the repo root works too.
 */
import { Window } from "happy-dom";

/** A NodeIterator with the DOM spec's behavior when the current node is removed. Forward only. */
class SpecNodeIterator {
  #reference: Node;
  #before = true;
  /** The node before the reference in tree order, kept for when the reference is removed. */
  #previous: Node | null = null;

  constructor(
    readonly root: Node,
    readonly whatToShow: number,
    readonly filter: NodeFilter | null,
  ) {
    this.#reference = root;
  }

  #following(node: Node): Node | null {
    if (node.firstChild) return node.firstChild;
    let n: Node | null = node;
    while (n && n !== this.root) {
      if (n.nextSibling) return n.nextSibling;
      n = n.parentNode;
    }
    return null;
  }

  #preceding(node: Node): Node | null {
    if (node === this.root) return null;
    let n = node.previousSibling;
    if (!n) return node.parentNode;
    while (n.lastChild) n = n.lastChild;
    return n;
  }

  #accept(node: Node): number {
    if (!((1 << (node.nodeType - 1)) & this.whatToShow)) return 3; // FILTER_SKIP
    if (!this.filter) return 1; // FILTER_ACCEPT
    return typeof this.filter === "function" ? this.filter(node) : this.filter.acceptNode(node);
  }

  nextNode(): Node | null {
    if (this.#reference !== this.root && !this.root.contains(this.#reference)) {
      const prev = this.#previous;
      if (prev && (prev === this.root || this.root.contains(prev))) {
        this.#reference = prev;
        this.#before = false;
      } else {
        this.#reference = this.root;
        this.#before = true;
      }
    }
    let node: Node | null = this.#reference;
    let before = this.#before;
    for (;;) {
      if (!before) {
        node = this.#following(node);
        if (!node) return null;
      } else before = false;
      if (this.#accept(node) === 1) break;
    }
    this.#reference = node;
    this.#before = false;
    this.#previous = this.#preceding(node);
    return node;
  }

  previousNode(): Node | null {
    throw new Error("previousNode is not supported in the test NodeIterator");
  }

  detach(): void {}
}

const KEY = "__starshipHappyDom";
const g = globalThis as unknown as Record<string, unknown>;

if (!g[KEY]) {
  const win = new Window({ url: "http://127.0.0.1/" });
  const source = win as unknown as Record<string, unknown>;
  const skip = new Set(["undefined", "NaN", "Infinity", "globalThis", "console", "process"]);
  for (const key of Object.getOwnPropertyNames(win)) {
    if (skip.has(key) || key in g) continue;
    g[key] = source[key];
  }
  // DOM classes live on the prototype chain of the happy-dom window.
  let proto: object | null = Object.getPrototypeOf(win);
  while (proto && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (skip.has(key) || key === "constructor" || key in g) continue;
      const value = source[key];
      g[key] = typeof value === "function" && !/^[A-Z]/.test(key) ? (value as (...a: unknown[]) => unknown).bind(win) : value;
    }
    proto = Object.getPrototypeOf(proto);
  }
  // In a browser, Node.prototype holds the one nodeName getter for every node.
  // happy-dom returns "" there and overrides it per subclass. DOMPurify reads the
  // Node.prototype getter directly, so without this it sees no tag names and
  // sanitizes nothing. Dispatch to the subclass getter, as a browser would.
  const nodeProto = win.Node.prototype as object;
  Object.defineProperty(nodeProto, "nodeName", {
    configurable: true,
    get(this: object): string {
      let p: object | null = Object.getPrototypeOf(this);
      while (p && p !== nodeProto) {
        const d = Object.getOwnPropertyDescriptor(p, "nodeName");
        if (d?.get) return d.get.call(this) as string;
        p = Object.getPrototypeOf(p);
      }
      return "";
    },
  });
  // happy-dom's NodeIterator stops when its current node is removed. A browser's
  // NodeIterator moves its reference to the node before it (DOM spec, "pre-removing
  // steps"). DOMPurify removes nodes as it walks, so without this it stops after
  // the first removal and leaves the rest unsanitized.
  let docProto: object | null = Object.getPrototypeOf(win.document);
  while (docProto && !Object.prototype.hasOwnProperty.call(docProto, "createNodeIterator")) docProto = Object.getPrototypeOf(docProto);
  if (!docProto) throw new Error("happy-dom: no createNodeIterator");
  (docProto as { createNodeIterator: unknown }).createNodeIterator = function createNodeIterator(root: Node, whatToShow = 0xffffffff, filter: NodeFilter | null = null) {
    return new SpecNodeIterator(root, whatToShow, filter);
  };
  g.window = win;
  g.document = win.document;
  g.navigator = win.navigator;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g[KEY] = true;
}
