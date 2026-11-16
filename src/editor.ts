// Live Preview display: hides the plugin's %% markers, shows a sent tag as a
// quiet chip and the thinking placeholder as an animated pill. The note's
// text doesn't change; only how it's drawn. Put the cursor on the line to see
// the raw text.

import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import { markerRanges } from "./core";

// What each tag in flight is doing now ("Searching the web", "Writing"), by id.
const statuses = new Map<string, string>();

/** Whether a tag is still being worked on in this session. */
export function isInFlight(id: string): boolean {
  return statuses.has(id);
}

/** Updates the label on a tag's pill, wherever it's showing. */
export function setPillStatus(id: string, status: string | null) {
  if (status === null) statuses.delete(id);
  else statuses.set(id, status);
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(`.inline-ai-thinking[data-ai-id="${id}"] > span`))) {
    el.textContent = status ?? "Thinking";
    el.parentElement?.classList.remove("is-stopped");
  }
}

class PillWidget extends WidgetType {
  constructor(readonly id: string) {
    super();
  }
  toDOM(): HTMLElement {
    const pill = document.createElement("span");
    pill.className = "inline-ai-thinking";
    pill.dataset.aiId = this.id;
    const label = pill.appendChild(document.createElement("span"));
    // A pill nobody is working on, e.g. Obsidian closed while it waited.
    if (!statuses.has(this.id)) pill.classList.add("is-stopped");
    label.textContent = statuses.get(this.id) ?? "Interrupted · run Clean up old tags";
    return pill;
  }
  eq(other: PillWidget): boolean {
    return other.id === this.id;
  }
}

const hide = Decoration.replace({});
const chip = Decoration.mark({ class: "inline-ai-tag" });
const pill = (id: string) => Decoration.replace({ widget: new PillWidget(id) });

export function inlineAIExtension(getTagWord: () => string) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        const modeChanged = u.startState.field(editorLivePreviewField, false) !== u.state.field(editorLivePreviewField, false);
        if (u.docChanged || u.viewportChanged || u.selectionSet || modeChanged) this.decorations = this.build(u.view);
      }
      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        if (!view.state.field(editorLivePreviewField, false)) return builder.finish();
        const doc = view.state.doc;
        const cursorLines = new Set(view.state.selection.ranges.flatMap((r) => [doc.lineAt(r.from).number, doc.lineAt(r.to).number]));

        let last = 0; // visible ranges can share a line; draw each line once
        for (const { from, to } of view.visibleRanges) {
          for (let n = Math.max(doc.lineAt(from).number, last + 1); n <= doc.lineAt(to).number; n++) {
            last = n;
            const line = doc.line(n);
            if (cursorLines.has(n) || !line.text.includes("%%")) continue;
            const r = markerRanges(line.text, getTagWord());
            const all: [number, number, Decoration][] = [
              ...r.hide.map(([a, b]) => [a, b, hide] as [number, number, Decoration]),
              ...r.tag.map(([a, b]) => [a, b, chip] as [number, number, Decoration]),
              ...r.pill.map(([a, b]) => [a, b, pill(/%%ai:([a-z0-9]+)%%/.exec(line.text.slice(a, b))?.[1] ?? "")] as [number, number, Decoration]),
            ].sort((x, y) => x[0] - y[0]);
            for (const [a, b, d] of all) builder.add(line.from + a, line.from + b, d);
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/**
 * Where a Reply to the card starting at `pos` goes: a new "> @ai " line at the
 * card's end, after a blank "> " line so it reads as a new turn.
 */
export function replySpot(doc: { lines: number; line(n: number): { text: string; to: number }; lineAt(pos: number): { number: number } }, pos: number, tagWord: string) {
  let n = doc.lineAt(pos).number;
  while (n < doc.lines && /^[ \t]*>/.test(doc.line(n + 1).text)) n++;
  const last = doc.line(n);
  const insert = (/^[ \t]*>[ \t]*$/.test(last.text) ? "" : "\n>") + "\n> " + tagWord + " ";
  return { from: last.to, insert, cursor: last.to + insert.length };
}

/**
 * A small Reply button at the foot of each answer card in Live Preview. It
 * starts a "> @ai " line inside the card, so the follow-up and its answer stay
 * in the card. Obsidian draws the card, so the button is added to its DOM.
 */
export function replyButtons(getTagWord: () => string) {
  return ViewPlugin.fromClass(
    class {
      private frame = 0;
      private observer: MutationObserver;
      constructor(readonly view: EditorView) {
        this.observer = new MutationObserver(() => this.schedule());
        this.observer.observe(view.contentDOM, { childList: true, subtree: true });
        this.schedule();
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.schedule();
      }
      schedule() {
        if (!this.frame) this.frame = requestAnimationFrame(() => ((this.frame = 0), this.addButtons()));
      }
      addButtons() {
        if (!this.view.state.field(editorLivePreviewField, false)) return;
        for (const card of Array.from(this.view.contentDOM.querySelectorAll<HTMLElement>('.callout[data-callout="ai"]'))) {
          if (card.querySelector(":scope > .inline-ai-reply")) continue;
          const button = card.appendChild(document.createElement("button"));
          button.className = "inline-ai-reply";
          button.textContent = "Reply";
          button.setAttribute("aria-label", "Ask a follow-up in this card");
          // Keep Obsidian from opening the card's source at the tap point.
          for (const type of ["pointerdown", "mousedown", "touchstart"]) {
            button.addEventListener(type, (ev) => (ev.stopPropagation(), type !== "touchstart" && ev.preventDefault()));
          }
          button.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this.reply(card);
          });
        }
      }
      reply(card: HTMLElement) {
        let pos: number;
        try {
          pos = this.view.posAtDOM(card);
        } catch {
          return;
        }
        const spot = replySpot(this.view.state.doc, pos, getTagWord());
        this.view.dispatch({
          changes: { from: spot.from, insert: spot.insert },
          selection: { anchor: spot.cursor },
          scrollIntoView: true,
          userEvent: "input",
        });
        this.view.focus();
      }
      destroy() {
        this.observer.disconnect();
        cancelAnimationFrame(this.frame);
      }
    },
  );
}
