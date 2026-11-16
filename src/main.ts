import { isolateHistory } from "@codemirror/commands";
import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Editor, MarkdownView, Notice, Plugin, TFile, requestUrl } from "obsidian";
import * as core from "./core";
import { inlineAIExtension, isInFlight, setPillStatus } from "./editor";
import { DEFAULT_SETTINGS, InlineAISettings, InlineAISettingTab } from "./settings";

export default class InlineAIPlugin extends Plugin {
  settings: InlineAISettings = { ...DEFAULT_SETTINGS };
  private lineCounts = new WeakMap<Editor, number>();
  private delivering = false;

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

    this.addCommand({
      id: "clean-up-tags",
      name: "Clean up old tags in this note",
      editorCallback: (editor) => {
        const changes = core.cleanupChanges(editor.getValue(), this.settings.tagWord, isInFlight);
        if (!changes.length) return new Notice("Inline AI: no old tags in this note.");
        editor.transaction({ changes: changes.map((c) => ({ from: editor.offsetToPos(c.from), to: editor.offsetToPos(c.to), text: c.insert })) });
        new Notice("Inline AI: cleaned up old tags. Interrupted ones are back as plain text, so you can send them again.");
      },
    });

    // Send a tag when you finish its line: the note gained a line and the
    // line above the cursor holds an unsent tag.
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        const count = editor.lineCount();
        const before = this.lineCounts.get(editor) ?? count;
        this.lineCounts.set(editor, count);
        if (this.delivering) return; // an answer arriving isn't you pressing Enter
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
    setPillStatus(id, "Thinking");
    editor.replaceRange(core.dispatchText(line, tag, id), { line: lineNo, ch: 0 }, { line: lineNo, ch: line.length });
    const context = core.buildContext(editor.getValue(), id, this.settings.tagWord);

    this.ask(id, tag.request, context, file.basename)
      .then(async (result) => ({
        ...result,
        answer: core.formatAnswer(await this.saveSvgs(result.answer, file, id), tag.request, this.settings.cards),
      }))
      .catch((err): core.Result => ({ answer: "", edits: null, error: `couldn't answer: ${errorText(err)}` }))
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
      if (idle) throw new Error("Claude went quiet for two minutes, so the request was stopped.");
      throw err;
    } finally {
      window.clearTimeout(timer);
    }
    const blocks = parser.finish();
    if (!parser.stopReason) throw new Error("the connection dropped before Claude finished.");
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

  // Finishes a tag: the answer takes its place, or the edits are made and it
  // goes away, or on failure it comes back as the plain text you typed. Uses
  // the open editor when it can, so your typing isn't disturbed and one undo
  // reverts the whole thing; otherwise edits the file directly.
  private async deliver(file: TFile, id: string, result: core.Result) {
    const tagWord = this.settings.tagWord;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file !== file || view.getMode() !== "source") continue;
      const plan = core.planChanges(view.editor.getValue(), id, result, tagWord);
      if (!plan) continue;
      const undoable = this.applyPlan(view.editor, plan);
      return this.report(plan, result, undoable);
    }

    let plan: core.Plan | null = null;
    await this.app.vault.process(file, (text) => {
      plan = core.planChanges(text, id, result, tagWord);
      return plan ? core.finalText(text, plan) : text;
    });
    if (plan) this.report(plan, result, false);
    else new Notice("Inline AI: an answer arrived, but its thinking line was deleted, so it was dropped.");
  }

  // Applies a plan in the editor. Returns whether one undo reverts it to the
  // plain tag you typed.
  private applyPlan(editor: Editor, plan: core.Plan): boolean {
    const cm = (editor as unknown as { cm?: EditorView }).cm;
    this.delivering = true;
    try {
      if (cm && typeof cm.dispatch === "function") {
        // Step 1, kept out of undo history: the slot becomes the plain tag.
        cm.dispatch({ changes: plan.restore, annotations: Transaction.addToHistory.of(false) });
        // Step 2, one undo step: the answer or edits.
        // Its own step, never merged with your typing.
        if (plan.changes.length) cm.dispatch({ changes: core.mapThrough(plan.changes, plan.restore), annotations: isolateHistory.of("full") });
        return true;
      }
      // No access to the editor's history: one change, undone back to the pill.
      const changes = plan.changes.length ? plan.changes : [plan.restore];
      editor.transaction({ changes: changes.map((c) => ({ from: editor.offsetToPos(c.from), to: editor.offsetToPos(c.to), text: c.insert })) });
      return false;
    } finally {
      this.delivering = false;
      this.lineCounts.set(editor, editor.lineCount());
    }
  }

  // Edits and problems are reported in a pop-up, so the note only holds your
  // writing and Claude's answers.
  private report(plan: core.Plan, result: core.Result, undoable: boolean) {
    if (plan.failure) {
      new Notice(`Inline AI ${plan.failure} Your tag is back as text: tap at its end and press Enter to send it again.`, 15000);
    } else if (plan.edited) {
      const what = result.note || `Edited ${plural(plan.edited, "passage")}.`;
      new Notice(`Inline AI: ${what}${/[.!?]$/.test(what) ? "" : "."}${undoable ? " Undo reverts it." : ""}`, 8000);
    }
    if (result.searchFailed && !plan.failure) {
      new Notice(`Inline AI: web search didn't work this time (${result.searchFailed.replace(/_/g, " ")}), so Claude answered without it.`, 10000);
    }
  }
}

// How long a streamed reply may go without sending anything before we give up.
const IDLE_LIMIT_MS = 120_000;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timed? ?out/i.test(msg)) return "the request timed out.";
  if (/failed to fetch|load failed|network|offline|ERR_/i.test(msg)) return `couldn't reach Anthropic (${msg}). Check your connection.`;
  return msg;
}
