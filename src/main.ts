import { Editor, MarkdownView, Notice, Plugin, TFile, requestUrl } from "obsidian";
import * as core from "./core";
import { DEFAULT_SETTINGS, InlineAISettings, InlineAISettingTab } from "./settings";

export default class InlineAIPlugin extends Plugin {
  settings: InlineAISettings = { ...DEFAULT_SETTINGS };
  private lineCounts = new WeakMap<Editor, number>();

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new InlineAISettingTab(this.app, this));

    // Fallback: send the tag on the cursor's line from the command palette.
    this.addCommand({
      id: "send-tag",
      name: "Send the tag on this line",
      editorCallback: (editor, ctx) => {
        if (ctx.file) this.sendTag(editor, ctx.file, editor.getCursor().line, true);
      },
    });

    // Send a tag when you finish its line: the note gained a line and the
    // line above the cursor holds an unsent tag.
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        const count = editor.lineCount();
        const before = this.lineCounts.get(editor) ?? count;
        this.lineCounts.set(editor, count);
        if (!this.settings.autoTrigger || count <= before || !info.file) return;
        const line = editor.getCursor().line;
        if (line > 0) this.sendTag(editor, info.file, line - 1, false);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const view = leaf?.view;
        if (view instanceof MarkdownView) this.lineCounts.set(view.editor, view.editor.lineCount());
      }),
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private sendTag(editor: Editor, file: TFile, lineNo: number, fromCommand: boolean) {
    const line = editor.getLine(lineNo);
    const tag = core.findTag(line, this.settings.tagWord);
    if (!tag) {
      if (fromCommand) new Notice(`No ${this.settings.tagWord} tag on this line.`);
      return;
    }
    if (!this.settings.apiKey) {
      new Notice("Inline AI: add your Anthropic API key in the plugin settings.");
      return;
    }

    // One edit: hide the tag in a comment and add the thinking line below it.
    const id = core.newId();
    editor.replaceRange(core.dispatchText(line, tag, id), { line: lineNo, ch: 0 }, { line: lineNo, ch: line.length });

    const at = editor.posToOffset({ line: lineNo + 1, ch: 0 });
    const context = core.buildContext(editor.getValue(), at, this.settings.contextChars);

    this.ask(tag.request, context)
      .then((answer) => this.saveSvgs(answer, file, id))
      .catch((err) => `> [!warning] Inline AI: ${err instanceof Error ? err.message : String(err)}`)
      .then((answer) => this.deliver(file, id, answer));
  }

  private async ask(request: string, context: string): Promise<string> {
    const { url, headers, body } = core.buildRequest(this.settings, request, context);
    const res = await requestUrl({ url, method: "POST", headers, body: JSON.stringify(body), throw: false });
    let json: unknown = null;
    try {
      json = res.json;
    } catch {
      // not JSON; parseResponse reports the status
    }
    return core.parseResponse(res.status, json);
  }

  // Saves each SVG in the answer as a file in your attachments folder and embeds it.
  private async saveSvgs(answer: string, file: TFile, id: string): Promise<string> {
    const { md, svgs } = core.extractSvgs(answer);
    let out = md;
    for (let i = 0; i < svgs.length; i++) {
      const path = await this.app.fileManager.getAvailablePathForAttachment(`ai-${id}-${i + 1}.svg`, file.path);
      const svgFile = await this.app.vault.create(path, svgs[i]);
      out = out.replace(`{{svg:${i}}}`, "!" + this.app.fileManager.generateMarkdownLink(svgFile, file.path));
    }
    return out;
  }

  // Replaces the thinking line with the answer. Uses the open editor when it
  // can, so your typing isn't disturbed; otherwise edits the file directly.
  private async deliver(file: TFile, id: string, answer: string) {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file !== file || view.getMode() !== "source") continue;
      const editor = view.editor;
      const lines = editor.getValue().split("\n");
      const i = core.findPlaceholder(lines, id);
      if (i < 0) continue;
      editor.replaceRange(core.replacementFor(lines, i, id, answer), { line: i, ch: 0 }, { line: i, ch: lines[i].length });
      return;
    }

    let found = false;
    await this.app.vault.process(file, (text) => {
      const updated = core.applyAnswer(text, id, answer);
      found = updated !== null;
      return updated ?? text;
    });
    if (!found) new Notice("Inline AI: an answer arrived, but its thinking line was deleted, so it was dropped.");
  }
}
