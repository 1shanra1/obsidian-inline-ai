// Live Preview display: hides the plugin's %% markers, shows a sent tag as a
// quiet chip and the thinking placeholder as an animated pill. The note's
// text doesn't change; only how it's drawn. Put the cursor on the line to see
// the raw text.

import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import { markerRanges } from "./core";

class PillWidget extends WidgetType {
  toDOM(): HTMLElement {
    const pill = document.createElement("span");
    pill.className = "inline-ai-thinking";
    const label = pill.appendChild(document.createElement("span"));
    label.textContent = "Thinking";
    return pill;
  }
  eq(): boolean {
    return true;
  }
}

const hide = Decoration.replace({});
const chip = Decoration.mark({ class: "inline-ai-tag" });
const pill = Decoration.replace({ widget: new PillWidget() });

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
              ...r.pill.map(([a, b]) => [a, b, pill] as [number, number, Decoration]),
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
