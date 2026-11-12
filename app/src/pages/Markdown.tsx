/**
 * Markdown from the feature folder: parsed by marked, then sanitized by DOMPurify.
 * This is the only place in the window that sets inner HTML.
 */
import createDOMPurify from "dompurify";
import { Marked } from "marked";

const marked = new Marked({
  gfm: true,
  async: false,
  renderer: {
    // A task-list box is a plain mark, never a form control.
    checkbox({ checked }) {
      return checked ? '<span class="box on">✓</span>' : '<span class="box"></span>';
    },
  },
});

type Purifier = ReturnType<typeof createDOMPurify>;
let purifier: Purifier | null = null;

function purify(): Purifier {
  if (purifier) return purifier;
  const p = createDOMPurify(window);
  p.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  purifier = p;
  return p;
}

/** Markdown in, safe HTML out. Exported for tests. */
export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false });
  return purify().sanitize(html, {
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "option", "iframe", "object", "embed"],
    FORBID_ATTR: ["style"],
  });
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const cls = className ? `md ${className}` : "md";
  return <div className={cls} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}
