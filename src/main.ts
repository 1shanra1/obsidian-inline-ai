import { Editor, MarkdownView, Notice, Plugin, TFile, requestUrl } from "obsidian";
import * as core from "./core";
import { inlineAIExtension, setPillStatus } from "./editor";
import { DEFAULT_SETTINGS, InlineAISettings, InlineAISettingTab } from "./settings";

export default class InlineAIPlugin extends Plugin {
  settings: InlineAISettings = { ...DEFAULT_SETTINGS };
  private lineCounts = new WeakMap<Editor, number>();

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new InlineAISettingTab(this.app, this));
    this.registerEditorExtension(inlineAIExtension(() => this.settings.tagWord));

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
    const context = core.buildContext(editor.getValue(), at);

    this.ask(id, tag.request, context, file.basename)
      .then(async (result) => ({ ...result, answer: await this.saveSvgs(result.answer, file, id) }))
      .catch((err): core.Result => ({ answer: `> [!warning] Inline AI couldn't answer: ${errorText(err)}`, edits: null }))
      .then((result) => this.deliver(file, id, result))
      .finally(() => setPillStatus(id, null));
  }

  private async ask(id: string, request: string, context: string, title: string): Promise<core.Result> {
    const { url, headers, body } = core.buildRequest(this.settings, request, context, title);
    let next = body;
    let blocks: any[] = [];
    // A long web search can pause the turn; continue it a few times at most.
    for (let round = 0; round < 4; round++) {
      const reply = await this.call(url, headers, next, (status) => setPillStatus(id, status));
      blocks = blocks.concat(reply.blocks);
      if (reply.stopReason === "refusal") throw new Error("Claude declined this request.");
      if (reply.stopReason !== "pause_turn") return core.resultFrom(blocks, reply.stopReason ?? "", this.settings.showSources);
      next = core.resumeBody(body, blocks);
    }
    throw new Error("the web search ran too long. Try a narrower request.");
  }

  // Streams the reply, so a long search or a long think never sits silent
  // long enough to time out. If streaming can't start, falls back to one
  // ordinary request.
  private async call(url: string, headers: Record<string, string>, body: object, onStatus: (s: string) => void): Promise<{ blocks: any[]; stopReason: string | null }> {
    const ctl = new AbortController();
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...body, stream: true }), signal: ctl.signal });
    } catch {
      return this.callOnce(url, headers, body);
    }
    if (!res.ok) {
      let json: any = null;
      try {
        json = await res.json();
      } catch {
        // not JSON; the status says enough
      }
      throw new Error(core.errorMessage(res.status, json));
    }
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
      const json = core.checkResponse(res.status, await res.json());
      return { blocks: json.content ?? [], stopReason: json.stop_reason ?? null };
    }

    const parser = new core.StreamParser(onStatus);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let idle = false;
    let timer = 0;
    const wait = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        idle = true;
        ctl.abort();
      }, IDLE_LIMIT_MS);
    };
    try {
      wait();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        wait();
        parser.push(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if (idle) throw new Error("Claude went quiet for two minutes, so the request was stopped. Tag again.");
      throw err;
    } finally {
      window.clearTimeout(timer);
    }
    const blocks = parser.finish();
    if (!parser.stopReason) throw new Error("the connection dropped before Claude finished. Tag again.");
    return { blocks, stopReason: parser.stopReason };
  }

  private async callOnce(url: string, headers: Record<string, string>, body: object): Promise<{ blocks: any[]; stopReason: string | null }> {
    const res = await requestUrl({ url, method: "POST", headers, body: JSON.stringify(body), throw: false });
    let json: any = null;
    try {
      json = res.json;
    } catch {
      // not JSON; checkResponse reports the status
    }
    core.checkResponse(res.status, json);
    return { blocks: json.content ?? [], stopReason: json.stop_reason ?? null };
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

  // Puts the answer where the thinking line is, and makes any edits, all in
  // one change so a single undo reverts it. Uses the open editor when it can,
  // so your typing isn't disturbed; otherwise edits the file directly.
  private async deliver(file: TFile, id: string, result: core.Result) {
    const tagWord = this.settings.tagWord;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file !== file || view.getMode() !== "source") continue;
      const editor = view.editor;
      const plan = core.planChanges(editor.getValue(), id, result, tagWord);
      if (!plan) continue;
      editor.transaction({
        changes: plan.changes.map((c) => ({ from: editor.offsetToPos(c.from), to: editor.offsetToPos(c.to), text: c.insert })),
      });
      if (plan.edited) new Notice(`Inline AI edited ${plural(plan.edited, "passage")}. Undo reverts it.`);
      return;
    }

    let edited = -1;
    await this.app.vault.process(file, (text) => {
      const plan = core.planChanges(text, id, result, tagWord);
      if (!plan) return text;
      edited = plan.edited;
      return core.applyChanges(text, plan.changes);
    });
    if (edited < 0) new Notice("Inline AI: an answer arrived, but its thinking line was deleted, so it was dropped.");
    else if (edited) new Notice(`Inline AI edited ${plural(edited, "passage")} in ${file.basename}.`);
  }
}

// How long a streamed reply may go without sending anything before we give up.
const IDLE_LIMIT_MS = 120_000;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timed? ?out/i.test(msg)) return "the request timed out. Tag again, or turn off web search for quick asks.";
  if (/failed to fetch|load failed|network|offline|ERR_/i.test(msg)) return `couldn't reach Anthropic (${msg}). Check your connection and tag again.`;
  return msg;
}
