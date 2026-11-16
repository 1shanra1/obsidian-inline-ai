"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => InlineAIPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian3 = require("obsidian");

// src/core.ts
var THINKING = '<span class="inline-ai-thinking"><span>Thinking</span></span>';
var THINKING_RE = '(?:<span class="inline-ai-thinking"><span>[^<]*</span></span>| \u23F3 \\*AI is thinking\u2026\\*)?';
var HERE = "<<<AI_TAG_HERE>>>";
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function findTag(line, tagWord = "@ai") {
  const re = new RegExp(`(^|\\s)${escapeRegex(tagWord)}\\s+(\\S.*?)\\s*$`);
  const m = re.exec(line);
  if (!m) return null;
  return { start: m.index + m[1].length, request: m[2] };
}
function newId() {
  return Math.random().toString(36).slice(2, 8);
}
function marker(id) {
  return `%%ai:${id}%%`;
}
function dispatchText(line, tag, id) {
  const hidden = line.slice(0, tag.start) + "%%" + line.slice(tag.start).trimEnd() + "%%";
  return hidden + "\n" + marker(id) + THINKING;
}
function findPlaceholder(lines, id) {
  return lines.findIndex((l) => l.includes(marker(id)));
}
function replacementFor(lines, i, id, answer) {
  const line = lines[i];
  const re = new RegExp(escapeRegex(marker(id)) + THINKING_RE);
  const m = re.exec(line);
  const before = line.slice(0, m.index);
  const after = line.slice(m.index + m[0].length).trimStart();
  let block = answer.trim();
  const above = before.trim() !== "" ? before : i > 0 ? lines[i - 1] : "";
  const below = after.trim() !== "" ? after : i < lines.length - 1 ? lines[i + 1] : "";
  if (above.trim() !== "") block = "\n" + block;
  if (below.trim() !== "") block = block + "\n";
  return (before.trim() !== "" ? before + "\n" : "") + block + (after.trim() !== "" ? "\n" + after : "");
}
function markerRanges(text, tagWord = "@ai") {
  const out = { hide: [], tag: [], pill: [] };
  const tagRe = new RegExp(`%%(${escapeRegex(tagWord)}\\s[^\\n]*?)%%`, "g");
  for (let m; m = tagRe.exec(text); ) {
    const start = m.index;
    const end = start + m[0].length;
    out.hide.push([start, start + 2], [end - 2, end]);
    out.tag.push([start + 2, end - 2]);
  }
  const pillRe = new RegExp("%%ai:[a-z0-9]+%%" + THINKING_RE, "g");
  for (let m; m = pillRe.exec(text); ) out.pill.push([m.index, m.index + m[0].length]);
  return out;
}
function applyAnswer(text, id, answer) {
  const lines = text.split("\n");
  const i = findPlaceholder(lines, id);
  if (i < 0) return null;
  lines[i] = replacementFor(lines, i, id, answer);
  return lines.join("\n");
}
function buildContext(text, at) {
  const strip = (t) => t.replace(/%%ai:[a-z0-9]+%%(?:<span class="inline-ai-thinking"><span>[^<]*<\/span><\/span>)?/g, "");
  return strip(text.slice(0, at)) + HERE + strip(text.slice(at));
}
var SYSTEM_PROMPT = `You are a writing partner inside the user's Obsidian note. While writing, they typed a quick inline request. Your reply is inserted at that spot, marked ${HERE}, and becomes part of the note. The request itself sits in a comment just above the spot.

Reading the request:
- It is about the text around the spot, above all the paragraph just before it. "Check this", "is this right?", "expand", "example?" refer to that text. Use the rest of the note and its title for the bigger picture.
- Answer it as it relates to the note, not the topic in general.

Writing the reply:
- Short by default: a sentence or two, a short paragraph, or a few bullets. Go longer only when the request asks for it.
- Make it read like part of the note: same language, voice and formatting habits as the text around it.
- No headings, callouts, warning boxes, disclaimers, preambles, sign-offs or source lists unless asked. Don't repeat the request or the user's text back.
- For a fact check, say plainly whether it holds up and correct only what's off.
- Tables, charts, diagrams and images only when asked or when they clearly beat prose here. Tables in Markdown. Charts and diagrams as a \`\`\`mermaid block (xychart-beta for bar or line charts, pie for pie charts). Images as one \`\`\`svg block holding a complete standalone SVG with xmlns and viewBox; it is saved as an image file.
- Math in LaTeX between $ or $$.
- Output only the content to insert, never wrapped in a code block.

Web search, when available:
- Use it when the answer depends on facts, figures, dates or anything recent. Skip it for writing, rewording or brainstorming.
- Use what you find without describing the search. If a figure is uncertain, say so in a few words.`;
var FALLBACK_MODELS = /^claude-(opus-5|fable-5|mythos-5|sonnet-5-5)/;
var DYNAMIC_SEARCH_MODELS = /^claude-(opus-5|opus-4-[678]|fable-5|mythos-5|sonnet-5|sonnet-4-6)/;
function buildRequest(s, request, context, title = "") {
  const headers = {
    "content-type": "application/json",
    "x-api-key": s.apiKey,
    "anthropic-version": "2026-10-21",
    "anthropic-dangerous-direct-browser-access": "true"
  };
  const body = {
    model: s.model,
    max_tokens: s.maxTokens,
    system: SYSTEM_PROMPT,
    output_config: { effort: s.effort },
    messages: [{ role: "user", content: `<note title="${title.replace(/"/g, "'")}">
${context}
</note>

Request: ${request}` }]
  };
  if (s.webSearch) {
    const type = DYNAMIC_SEARCH_MODELS.test(s.model) ? "web_search_20260209" : "web_search_20250305";
    body.tools = [{ type, name: "web_search", max_uses: 3 }];
  }
  if (s.refusalFallback && FALLBACK_MODELS.test(s.model)) {
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    body.fallbacks = "default";
  }
  return { url: "https://api.anthropic.com/v1/messages", headers, body };
}
function checkResponse(status, json) {
  if (status >= 400 || !json || json.type === "error") {
    const msg = json?.error?.message ?? `request failed (HTTP ${status})`;
    throw new Error(msg);
  }
  if (json.stop_reason === "refusal") {
    throw new Error("Claude declined this request.");
  }
  return json;
}
function resumeBody(body, contentSoFar) {
  return { ...body, messages: [body.messages[0], { role: "assistant", content: contentSoFar }] };
}
function answerFrom(blocks, stopReason, showSources = false) {
  const used = /* @__PURE__ */ new Set();
  let text = "";
  for (const b of blocks) {
    if (b.type !== "text") continue;
    text += b.text;
    const c = (b.citations ?? []).find((c2) => c2.url && !used.has(c2.url));
    if (showSources && c && used.size < 3) {
      used.add(c.url);
      text += ` ([${domainOf(c.url)}](${c.url.replace(/\)/g, "%29").replace(/ /g, "%20")}))`;
    }
  }
  let out = unwrapFence(text);
  if (stopReason === "max_tokens") out += "\n\n*(cut off: hit the max tokens setting)*";
  return out;
}
function domainOf(url) {
  const m = /^https?:\/\/(?:www\.)?([^/?#]+)/.exec(url);
  return m ? m[1] : "source";
}
function unwrapFence(text) {
  const m = /^\s*```(?:markdown|md)[ \t]*\n([\s\S]*?)\n```\s*$/.exec(text);
  return m ? m[1] : text;
}
function extractSvgs(md) {
  const svgs = [];
  const out = md.replace(/```(?:svg|xml|html)?[ \t]*\n\s*(<svg[\s\S]*?<\/svg>)\s*\n```/g, (_all, svg) => {
    svgs.push(svg);
    return `{{svg:${svgs.length - 1}}}`;
  });
  return { md: out, svgs };
}

// src/editor.ts
var import_state = require("@codemirror/state");
var import_view = require("@codemirror/view");
var import_obsidian = require("obsidian");
var PillWidget = class extends import_view.WidgetType {
  toDOM() {
    const pill2 = document.createElement("span");
    pill2.className = "inline-ai-thinking";
    const label = pill2.appendChild(document.createElement("span"));
    label.textContent = "Thinking";
    return pill2;
  }
  eq() {
    return true;
  }
};
var hide = import_view.Decoration.replace({});
var chip = import_view.Decoration.mark({ class: "inline-ai-tag" });
var pill = import_view.Decoration.replace({ widget: new PillWidget() });
function inlineAIExtension(getTagWord) {
  return import_view.ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.build(view);
      }
      update(u) {
        const modeChanged = u.startState.field(import_obsidian.editorLivePreviewField, false) !== u.state.field(import_obsidian.editorLivePreviewField, false);
        if (u.docChanged || u.viewportChanged || u.selectionSet || modeChanged) this.decorations = this.build(u.view);
      }
      build(view) {
        const builder = new import_state.RangeSetBuilder();
        if (!view.state.field(import_obsidian.editorLivePreviewField, false)) return builder.finish();
        const doc = view.state.doc;
        const cursorLines = new Set(view.state.selection.ranges.flatMap((r) => [doc.lineAt(r.from).number, doc.lineAt(r.to).number]));
        let last = 0;
        for (const { from, to } of view.visibleRanges) {
          for (let n = Math.max(doc.lineAt(from).number, last + 1); n <= doc.lineAt(to).number; n++) {
            last = n;
            const line = doc.line(n);
            if (cursorLines.has(n) || !line.text.includes("%%")) continue;
            const r = markerRanges(line.text, getTagWord());
            const all = [
              ...r.hide.map(([a, b]) => [a, b, hide]),
              ...r.tag.map(([a, b]) => [a, b, chip]),
              ...r.pill.map(([a, b]) => [a, b, pill])
            ].sort((x, y) => x[0] - y[0]);
            for (const [a, b, d] of all) builder.add(line.from + a, line.from + b, d);
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}

// src/settings.ts
var import_obsidian2 = require("obsidian");
var DEFAULT_SETTINGS = {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "medium",
  tagWord: "@ai",
  autoTrigger: true,
  maxTokens: 16e3,
  refusalFallback: true,
  webSearch: true,
  showSources: true
};
var InlineAISettingTab = class extends import_obsidian2.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();
    new import_obsidian2.Setting(containerEl).setName("Anthropic API key").setDesc("Stored in this plugin's data.json inside your vault, so it syncs with your vault.").addText((t) => {
      t.inputEl.type = "password";
      t.setPlaceholder("sk-ant-...").setValue(s.apiKey).onChange(async (v) => {
        s.apiKey = v.trim();
        await save();
      });
    });
    new import_obsidian2.Setting(containerEl).setName("Model").setDesc("Any Claude model id, e.g. claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5.").addText((t) => t.setValue(s.model).onChange(async (v) => {
      s.model = v.trim();
      await save();
    }));
    new import_obsidian2.Setting(containerEl).setName("Effort").setDesc("Lower is faster and cheaper; higher thinks harder.").addDropdown((d) => {
      for (const e of ["low", "medium", "high", "xhigh", "max"]) d.addOption(e, e);
      d.setValue(s.effort).onChange(async (v) => {
        s.effort = v;
        await save();
      });
    });
    new import_obsidian2.Setting(containerEl).setName("Tag word").setDesc("What you type before a request.").addText((t) => t.setValue(s.tagWord).onChange(async (v) => {
      s.tagWord = v.trim() || "@ai";
      await save();
    }));
    new import_obsidian2.Setting(containerEl).setName("Send on Enter").setDesc("Send a tag when you finish its line. Off means only the command sends it.").addToggle((t) => t.setValue(s.autoTrigger).onChange(async (v) => {
      s.autoTrigger = v;
      await save();
    }));
    new import_obsidian2.Setting(containerEl).setName("Web search").setDesc("Let Claude look things up when a request needs facts or anything recent. Costs a little per search.").addToggle((t) => t.setValue(s.webSearch).onChange(async (v) => {
      s.webSearch = v;
      await save();
    }));
    new import_obsidian2.Setting(containerEl).setName("Source links").setDesc("Add a short link after facts Claude found on the web (three at most).").addToggle((t) => t.setValue(s.showSources).onChange(async (v) => {
      s.showSources = v;
      await save();
    }));
    new import_obsidian2.Setting(containerEl).setName("Max answer tokens").addText((t) => t.setValue(String(s.maxTokens)).onChange(async (v) => {
      s.maxTokens = Number(v) || DEFAULT_SETTINGS.maxTokens;
      await save();
    }));
    new import_obsidian2.Setting(containerEl).setName("Retry declined requests on another model").setDesc("If Claude's safety checks decline a request, Anthropic re-runs it on a fallback model.").addToggle((t) => t.setValue(s.refusalFallback).onChange(async (v) => {
      s.refusalFallback = v;
      await save();
    }));
  }
};

// src/main.ts
var InlineAIPlugin = class extends import_obsidian3.Plugin {
  constructor() {
    super(...arguments);
    this.settings = { ...DEFAULT_SETTINGS };
    this.lineCounts = /* @__PURE__ */ new WeakMap();
  }
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new InlineAISettingTab(this.app, this));
    this.registerEditorExtension(inlineAIExtension(() => this.settings.tagWord));
    this.addCommand({
      id: "send-tag",
      name: "Send the tag on this line",
      editorCallback: (editor, ctx) => {
        if (ctx.file) this.sendTag(editor, ctx.file, editor.getCursor().line, true);
      }
    });
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        const count = editor.lineCount();
        const before = this.lineCounts.get(editor) ?? count;
        this.lineCounts.set(editor, count);
        if (!this.settings.autoTrigger || count <= before || !info.file) return;
        const line = editor.getCursor().line;
        if (line > 0) this.sendTag(editor, info.file, line - 1, false);
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const view = leaf?.view;
        if (view instanceof import_obsidian3.MarkdownView) this.lineCounts.set(view.editor, view.editor.lineCount());
      })
    );
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  sendTag(editor, file, lineNo, fromCommand) {
    const line = editor.getLine(lineNo);
    const tag = findTag(line, this.settings.tagWord);
    if (!tag) {
      if (fromCommand) new import_obsidian3.Notice(`No ${this.settings.tagWord} tag on this line.`);
      return;
    }
    if (!this.settings.apiKey) {
      new import_obsidian3.Notice("Inline AI: add your Anthropic API key in the plugin settings.");
      return;
    }
    const id = newId();
    editor.replaceRange(dispatchText(line, tag, id), { line: lineNo, ch: 0 }, { line: lineNo, ch: line.length });
    const at = editor.posToOffset({ line: lineNo + 1, ch: 0 });
    const context = buildContext(editor.getValue(), at);
    this.ask(tag.request, context, file.basename).then((answer) => this.saveSvgs(answer, file, id)).catch((err) => `> [!warning] Inline AI: ${err instanceof Error ? err.message : String(err)}`).then((answer) => this.deliver(file, id, answer));
  }
  async ask(request, context, title) {
    const { url, headers, body } = buildRequest(this.settings, request, context, title);
    let next = body;
    let blocks = [];
    for (let round = 0; round < 4; round++) {
      const res = await (0, import_obsidian3.requestUrl)({ url, method: "POST", headers, body: JSON.stringify(next), throw: false });
      let json = null;
      try {
        json = res.json;
      } catch {
      }
      checkResponse(res.status, json);
      blocks = blocks.concat(json.content ?? []);
      if (json.stop_reason !== "pause_turn") return answerFrom(blocks, json.stop_reason, this.settings.showSources);
      next = resumeBody(body, blocks);
    }
    throw new Error("the web search ran too long. Try a narrower request.");
  }
  // Saves each SVG in the answer as a file in your attachments folder and embeds it.
  async saveSvgs(answer, file, id) {
    const { md, svgs } = extractSvgs(answer);
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
  async deliver(file, id, answer) {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof import_obsidian3.MarkdownView) || view.file !== file || view.getMode() !== "source") continue;
      const editor = view.editor;
      const lines = editor.getValue().split("\n");
      const i = findPlaceholder(lines, id);
      if (i < 0) continue;
      editor.replaceRange(replacementFor(lines, i, id, answer), { line: i, ch: 0 }, { line: i, ch: lines[i].length });
      return;
    }
    let found = false;
    await this.app.vault.process(file, (text) => {
      const updated = applyAnswer(text, id, answer);
      found = updated !== null;
      return updated ?? text;
    });
    if (!found) new import_obsidian3.Notice("Inline AI: an answer arrived, but its thinking line was deleted, so it was dropped.");
  }
};
