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
var import_commands = require("@codemirror/commands");
var import_state2 = require("@codemirror/state");
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
function findSlot(text, id, tagWord = "@ai") {
  const lines = text.split("\n");
  const i = findPlaceholder(lines, id);
  if (i < 0) return null;
  const starts = [];
  let o = 0;
  for (const l of lines) {
    starts.push(o);
    o += l.length + 1;
  }
  const line = lines[i];
  const m = new RegExp(escapeRegex(marker(id)) + THINKING_RE).exec(line);
  const beforePill = line.slice(0, m.index).trimEnd();
  const afterPill = line.slice(m.index + m[0].length).trim();
  const tagM = i > 0 ? new RegExp(`%%(${escapeRegex(tagWord)}\\s[^\\n]*?)%%\\s*$`).exec(lines[i - 1]) : null;
  const first = tagM ? i - 1 : i;
  const beforeTag = tagM ? lines[i - 1].slice(0, tagM.index).trimEnd() : "";
  return {
    from: starts[first],
    to: starts[i] + line.length,
    hereFrom: tagM ? starts[i - 1] + tagM.index : starts[i] + m.index,
    hereTo: starts[i] + m.index + m[0].length,
    keptBefore: [beforeTag, beforePill].filter((t) => t !== ""),
    keptAfter: afterPill,
    restore: [tagM ? lines[i - 1].slice(0, tagM.index) + tagM[1] : "", beforePill, afterPill].filter((t) => t.trim() !== "").join("\n"),
    above: first > 0 ? lines[first - 1] : "",
    below: i < lines.length - 1 ? lines[i + 1] : ""
  };
}
function allSlots(text, tagWord) {
  const out = [];
  for (const m of text.matchAll(/%%ai:([a-z0-9]+)%%/g)) {
    const slot = findSlot(text, m[1], tagWord);
    if (slot) out.push({ id: m[1], slot });
  }
  return out;
}
function slotText(slot, answer) {
  if (!answer.trim()) return [...slot.keptBefore, slot.keptAfter].filter((t) => t !== "").join("\n");
  let block = answer.trim();
  const above = slot.keptBefore.length ? slot.keptBefore[slot.keptBefore.length - 1] : slot.above;
  const below = slot.keptAfter || slot.below;
  if (above.trim() !== "") block = "\n" + block;
  if (below.trim() !== "") block = block + "\n";
  return [...slot.keptBefore, block, ...slot.keptAfter ? [slot.keptAfter] : []].join("\n");
}
function buildContext(text, id, tagWord = "@ai") {
  const cuts = allSlots(text, tagWord).map(({ id: other, slot }) => ({ from: slot.hereFrom, to: slot.hereTo, insert: other === id ? HERE : "" }));
  return applyChanges(text, cuts);
}
var BASE_PROMPT = `You are a reading companion inside the user's Obsidian note. They take notes while reading books, and they want help understanding and remembering what they read: explanations, numbers and facts, answers to their questions, examples, and links between ideas. While writing, they typed a quick request. Your reply takes the place of the spot where they typed it, marked ${HERE}, and becomes part of the note. The request is given after the note.

Reading the request:
- It is about the text around the spot, above all the paragraph just before it. "Check this", "is this right?", "explain", "example?" refer to that text. The note's title is often the book; use it and the rest of the note for the bigger picture.
- Answer as it relates to their notes and the book's ideas, not the topic in general. When it helps, tie the answer back to an idea or phrase already in the note.

Fit the length to the request:
- A number, date or fact: one line, the figure first, with its year.
- A quick question or "is this right?": one to three sentences. For a fact check, say plainly whether it holds up and correct only what's off.
- An explainer ("explain", "why", "how", "help me understand"): the core idea first, in one or two plain sentences. Then only the parts that help it stick: a concrete example, how it connects to what they wrote, and a one-line takeaway. Under about 200 words unless they ask for more.
- Several figures or a comparison: a small table.
- If they ask for more depth or detail, go longer, still in short parts.

Formatting, so it's easy to take in:
- Plain, clear words. Short paragraphs of one to three sentences, with a blank line between them.
- Bold only the one or two key terms. Use a list only for a real list or steps, five items at most.
- In longer replies, start each part with a bold lead-in such as **Example:** or **Why it matters:**, never a heading.
- When the reply is longer than three sentences, make its first line "Title: " and three to six words naming the idea. The reply is then shown as a card under that title. Short replies get no title.
- No headings, callouts, horizontal rules, emoji, disclaimers, preambles, sign-offs or source lists. Cards in the note are added by the app; don't write them yourself. Don't repeat the request or their text back.
- If figures for the year or period asked about aren't published yet, say so in a few words and give the newest published figures with their year.
- Tables, charts, diagrams and images only when asked or when they clearly beat prose here. Tables in Markdown. Charts and diagrams as a \`\`\`mermaid block (xychart-beta for bar or line charts, pie for pie charts). Images as one \`\`\`svg block holding a complete standalone SVG with xmlns and viewBox; it is saved as an image file.
- Math in LaTeX between $ or $$.
- Output only the content to insert, never wrapped in a code block.

Web search, when available:
- Use it when the answer depends on facts, figures, dates or anything recent. Skip it for writing, rewording or brainstorming.
- Use what you find without describing the search. If a figure is uncertain, say so in a few words.`;
var EDIT_PROMPT = `Changing the note:
- When the request asks to change text that is already in the note (fix, correct, update, rewrite, shorten, reformat, "make this ..."), call edit_note instead of writing a reply.
- Each edit's find is copied character for character from the note, just long enough to appear only once, and covers only the passage that changes. Never include ${HERE}.
- To remove something, replace it with an empty string. Blank lines left behind are tidied up for you.
- Lines like %%@ai ...%% are earlier requests whose answers are already in the note. When you remove what one asked for, remove its line too.
- Call edit_note at most once, with every edit, as your last step. Its note is a few words on what you changed, shown briefly as a pop-up, not added to the note. Write nothing else.
- If the request asks a question or wants new content, reply as usual and don't edit.`;
function systemPrompt(allowEdits = true) {
  return allowEdits ? BASE_PROMPT + "\n\n" + EDIT_PROMPT : BASE_PROMPT;
}
var EDIT_TOOL = {
  name: "edit_note",
  description: "Change text that is already in the note. Each edit replaces one exact passage with new text. All edits are applied together as one undoable change, or not at all if any passage can't be found exactly once.",
  input_schema: {
    type: "object",
    properties: {
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            find: { type: "string", description: "Exact text from the note that appears only once." },
            replace: { type: "string", description: "The new text for that passage." }
          },
          required: ["find", "replace"]
        }
      },
      note: { type: "string", description: "A few words on what changed, shown as a brief pop-up." }
    },
    required: ["edits"]
  }
};
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
    system: systemPrompt(s.allowEdits),
    output_config: { effort: s.effort },
    messages: [{ role: "user", content: `<note title="${title.replace(/"/g, "'")}">
${context}
</note>

Request: ${request}` }]
  };
  const tools = [];
  if (s.webSearch) {
    const type = DYNAMIC_SEARCH_MODELS.test(s.model) ? "web_search_20260209" : "web_search_20250305";
    tools.push({ type, name: "web_search", max_uses: 3 });
  }
  if (s.allowEdits) tools.push(EDIT_TOOL);
  if (tools.length) body.tools = tools;
  if (s.refusalFallback && FALLBACK_MODELS.test(s.model)) {
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    body.fallbacks = "default";
  }
  return { url: "https://api.anthropic.com/v1/messages", headers, body };
}
function errorMessage(status, json) {
  const type = json?.error?.type;
  const msg = json?.error?.message;
  if (status === 401 || type === "authentication_error") return "Anthropic didn't accept the API key. Check it in Inline AI's settings.";
  if (status === 429 || type === "rate_limit_error") return "hit the API rate limit. Wait a moment and try again.";
  if (status === 529 || type === "overloaded_error") return "Anthropic is overloaded right now. Try again in a minute.";
  if (status === 404 || type === "not_found_error") return `${msg ?? "not found"}. Check the model name in Inline AI's settings.`;
  return msg ?? `the request failed (HTTP ${status}).`;
}
function checkResponse(status, json) {
  if (status >= 400 || !json || json.type === "error") throw new Error(errorMessage(status, json));
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
function resultFrom(blocks, stopReason, showSources = false) {
  const failed = blocks.find((b) => b?.type === "web_search_tool_result" && b.content?.type === "web_search_tool_result_error");
  const searchFailed = failed ? failed.content.error_code ?? "unknown" : void 0;
  const call = blocks.find((b) => b?.type === "tool_use" && b.name === EDIT_TOOL.name);
  if (!call) return { answer: answerFrom(blocks, stopReason, showSources), edits: null, searchFailed };
  const input = call.input;
  const ok = input && Array.isArray(input.edits) && input.edits.every((e) => e && typeof e.find === "string" && typeof e.replace === "string");
  if (!ok) throw new Error(stopReason === "max_tokens" ? "the edit was cut off by the max tokens setting." : "Claude's edit came back incomplete.");
  return {
    answer: "",
    edits: input.edits.map((e) => ({ find: e.find, replace: e.replace })),
    note: typeof input.note === "string" ? input.note.trim() : "",
    searchFailed
  };
}
function locateEdits(text, edits, protectedRanges) {
  const out = [];
  for (const e of edits) {
    if (!e.find) return "an edit didn't say which text to change.";
    if (e.find.includes(HERE) || e.replace.includes("%%ai:")) return "an edit reached into the request itself.";
    const at = text.indexOf(e.find);
    if (at < 0) return "the text it meant to change isn't in the note any more.";
    if (text.indexOf(e.find, at + 1) >= 0) return "the text it meant to change appears more than once.";
    const end = at + e.find.length;
    if (protectedRanges.some(([p, q]) => at < q && p < end)) return "an edit reached into a request that's still waiting.";
    out.push({ from: at, to: end, insert: e.replace });
  }
  out.sort((a, b) => a.from - b.from);
  for (let k = 1; k < out.length; k++) if (out[k].from < out[k - 1].to) return "two of its edits overlapped.";
  return out;
}
var WS = /[ \t\n]/;
var BLANK_LINE = /\n[ \t]*\n/;
function tidyGaps(text, changes) {
  const sorted = [...changes].sort((a, b) => a.from - b.from);
  const out = [];
  sorted.forEach((c, k) => {
    const lo = k > 0 ? sorted[k - 1].to : 0;
    const hi = k < sorted.length - 1 ? sorted[k + 1].from : text.length;
    if (c.insert.trim() !== "") return out.push({ ...c, blank: false, para: false });
    let L = c.from;
    while (L > lo && WS.test(text[L - 1])) L--;
    let R = c.to;
    while (R < hi) {
      const nl = text.indexOf("\n", R);
      const end = nl < 0 ? text.length : nl + 1;
      if (end > hi || text.slice(R, end).trim() !== "") break;
      R = end;
    }
    const removed = text.slice(c.from, c.to);
    const left = text.slice(L, c.from) + /^\s*/.exec(removed)[0];
    const right = /\s*$/.exec(removed)[0] + text.slice(c.to, R);
    if (!(left + c.insert + right).includes("\n")) return out.push({ ...c, blank: false, para: false });
    out.push({ from: L, to: R, insert: "", blank: true, para: BLANK_LINE.test(left) || BLANK_LINE.test(right) });
  });
  const merged = [];
  for (const g of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.blank && g.blank && g.from <= prev.to) {
      prev.to = Math.max(prev.to, g.to);
      prev.para = prev.para || g.para || BLANK_LINE.test(text.slice(prev.to, g.from));
    } else merged.push({ ...g });
  }
  return merged.map((g) => {
    if (!g.blank) return { from: g.from, to: g.to, insert: g.insert };
    const sep = g.from === 0 ? "" : g.to === text.length ? text.endsWith("\n") ? "\n" : "" : g.para ? "\n\n" : "\n";
    return { from: g.from, to: g.to, insert: sep };
  });
}
function planChanges(text, id, result, tagWord = "@ai") {
  const slot = findSlot(text, id, tagWord);
  if (!slot) return null;
  const restore = { from: slot.from, to: slot.to, insert: slot.restore };
  if (result.error) return { restore, changes: [], edited: 0, failure: result.error };
  if (!result.edits) return { restore, changes: tidyGaps(text, [{ from: slot.from, to: slot.to, insert: slotText(slot, result.answer) }]), edited: 0 };
  const protectedRanges = [
    [Math.max(0, slot.from - 1), slot.to + 1],
    ...allSlots(text, tagWord).map(({ slot: s }) => [s.from, s.to])
  ];
  const located = locateEdits(text, result.edits, protectedRanges);
  if (typeof located === "string") return { restore, changes: [], edited: 0, failure: `couldn't make the edit: ${located}` };
  const changes = tidyGaps(text, [...located, { from: slot.from, to: slot.to, insert: slotText(slot, "") }]);
  return { restore, changes, edited: located.length };
}
function mapThrough(changes, r) {
  const delta = r.insert.length - (r.to - r.from);
  const map = (p, end) => p <= r.from ? p : p >= r.to ? p + delta : end ? r.from + r.insert.length : r.from;
  return changes.map((c) => ({ from: map(c.from, false), to: map(c.to, true), insert: c.insert }));
}
function finalText(text, plan) {
  return applyChanges(applyChanges(text, [plan.restore]), mapThrough(plan.changes, plan.restore));
}
function cleanupChanges(text, tagWord, isLive) {
  const changes = [];
  const slots = allSlots(text, tagWord);
  for (const { id, slot } of slots) if (!isLive(id)) changes.push({ from: slot.from, to: slot.to, insert: slot.restore });
  const tagRe = new RegExp(`%%${escapeRegex(tagWord)}\\s[^\\n]*?%%`, "g");
  for (const m of text.matchAll(tagRe)) {
    const a = m.index;
    const b = a + m[0].length;
    if (slots.some(({ slot }) => a >= slot.from && b <= slot.to)) continue;
    changes.push({ from: a, to: b, insert: "" });
  }
  return tidyGaps(text, changes);
}
function applyChanges(text, changes) {
  let out = text;
  for (const c of [...changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}
var StreamParser = class {
  constructor(onStatus = () => {
  }) {
    this.blocks = [];
    this.stopReason = null;
    this.buf = "";
    this.json = /* @__PURE__ */ new Map();
    this.status = "";
    this.onStatus = onStatus;
  }
  push(chunk) {
    this.buf += chunk.replace(/\r/g, "");
    for (let k; (k = this.buf.indexOf("\n\n")) >= 0; ) {
      const raw = this.buf.slice(0, k);
      this.buf = this.buf.slice(k + 2);
      const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) this.event(JSON.parse(data));
    }
  }
  /** The reply's content blocks, once the stream has ended. */
  finish() {
    if (this.buf.trim()) this.push("\n\n");
    for (const i of [...this.json.keys()]) this.closeBlock(i);
    return this.blocks.filter(Boolean);
  }
  say(status) {
    if (status === this.status) return;
    this.status = status;
    this.onStatus(status);
  }
  event(e) {
    switch (e.type) {
      case "content_block_start": {
        const b = { ...e.content_block };
        this.blocks[e.index] = b;
        if (b.type === "tool_use" || b.type === "server_tool_use") this.json.set(e.index, "");
        if (b.type === "thinking" || b.type === "redacted_thinking") this.say("Thinking");
        else if (b.type === "server_tool_use") this.say("Searching the web");
        else if (b.type === "web_search_tool_result") this.say("Reading");
        else if (b.type === "text") this.say("Writing");
        else if (b.type === "tool_use") this.say("Editing");
        return;
      }
      case "content_block_delta": {
        const b = this.blocks[e.index];
        const d = e.delta ?? {};
        if (!b) return;
        if (d.type === "text_delta") b.text = (b.text ?? "") + d.text;
        else if (d.type === "thinking_delta") b.thinking = (b.thinking ?? "") + d.thinking;
        else if (d.type === "signature_delta") b.signature = d.signature;
        else if (d.type === "citations_delta") (b.citations ?? (b.citations = [])).push(d.citation);
        else if (d.type === "input_json_delta") this.json.set(e.index, (this.json.get(e.index) ?? "") + d.partial_json);
        return;
      }
      case "content_block_stop":
        this.closeBlock(e.index);
        return;
      case "message_delta":
        if (e.delta?.stop_reason) this.stopReason = e.delta.stop_reason;
        return;
      case "error":
        throw new Error(errorMessage(0, e));
    }
  }
  closeBlock(i) {
    if (!this.json.has(i)) return;
    const raw = this.json.get(i);
    this.json.delete(i);
    const b = this.blocks[i];
    if (!raw) return;
    try {
      b.input = JSON.parse(raw);
    } catch {
      b.input = null;
    }
  }
};
function formatAnswer(answer, request, cards = true) {
  const m = /^\s*Title:[ \t]*(.+?)[ \t]*(?:\n|$)/i.exec(answer);
  const body = (m ? answer.slice(m[0].length) : answer).trim();
  if (!cards || !body) return body;
  const long = body.length > 450 || body.split("\n").filter((l) => l.trim()).length > 4 || /^\s*(\||```|\$\$)/m.test(body);
  if (!m && !long) return body;
  const title = cardTitle(m ? m[1] : request);
  return [`> [!ai]+ ${title}`, ...body.split("\n").map((l) => l.trim() ? "> " + l : ">")].join("\n");
}
function cardTitle(text) {
  let t = text.replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim().replace(/[.:;,!?]+$/, "");
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, "") + "\u2026";
  return t.charAt(0).toUpperCase() + t.slice(1);
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
var statuses = /* @__PURE__ */ new Map();
function isInFlight(id) {
  return statuses.has(id);
}
function setPillStatus(id, status) {
  if (status === null) statuses.delete(id);
  else statuses.set(id, status);
  for (const el of Array.from(document.querySelectorAll(`.inline-ai-thinking[data-ai-id="${id}"] > span`))) {
    el.textContent = status ?? "Thinking";
    el.parentElement?.classList.remove("is-stopped");
  }
}
var PillWidget = class extends import_view.WidgetType {
  constructor(id) {
    super();
    this.id = id;
  }
  toDOM() {
    const pill2 = document.createElement("span");
    pill2.className = "inline-ai-thinking";
    pill2.dataset.aiId = this.id;
    const label = pill2.appendChild(document.createElement("span"));
    if (!statuses.has(this.id)) pill2.classList.add("is-stopped");
    label.textContent = statuses.get(this.id) ?? "Interrupted \xB7 run Clean up old tags";
    return pill2;
  }
  eq(other) {
    return other.id === this.id;
  }
};
var hide = import_view.Decoration.replace({});
var chip = import_view.Decoration.mark({ class: "inline-ai-tag" });
var pill = (id) => import_view.Decoration.replace({ widget: new PillWidget(id) });
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
              ...r.pill.map(([a, b]) => [a, b, pill(/%%ai:([a-z0-9]+)%%/.exec(line.text.slice(a, b))?.[1] ?? "")])
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
  showSources: true,
  allowEdits: true,
  cards: true
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
    new import_obsidian2.Setting(containerEl).setName("Answer cards").setDesc("Show longer answers in a card you can fold away. Short answers stay plain text either way.").addToggle((t) => t.setValue(s.cards).onChange(async (v) => {
      s.cards = v;
      await save();
    }));
    new import_obsidian2.Setting(containerEl).setName("Let Claude edit the note").setDesc("When you ask it to fix, update or rewrite something, Claude changes that text in place. One undo reverts it.").addToggle((t) => t.setValue(s.allowEdits).onChange(async (v) => {
      s.allowEdits = v;
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
    this.delivering = false;
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
    this.addCommand({
      id: "clean-up-tags",
      name: "Clean up old tags in this note",
      editorCallback: (editor) => {
        const changes = cleanupChanges(editor.getValue(), this.settings.tagWord, isInFlight);
        if (!changes.length) return new import_obsidian3.Notice("Inline AI: no old tags in this note.");
        editor.transaction({ changes: changes.map((c) => ({ from: editor.offsetToPos(c.from), to: editor.offsetToPos(c.to), text: c.insert })) });
        new import_obsidian3.Notice("Inline AI: cleaned up old tags. Interrupted ones are back as plain text, so you can send them again.");
      }
    });
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        const count = editor.lineCount();
        const before = this.lineCounts.get(editor) ?? count;
        this.lineCounts.set(editor, count);
        if (this.delivering) return;
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
    setPillStatus(id, "Thinking");
    editor.replaceRange(dispatchText(line, tag, id), { line: lineNo, ch: 0 }, { line: lineNo, ch: line.length });
    const context = buildContext(editor.getValue(), id, this.settings.tagWord);
    this.ask(id, tag.request, context, file.basename).then(async (result) => ({
      ...result,
      answer: formatAnswer(await this.saveSvgs(result.answer, file, id), tag.request, this.settings.cards)
    })).catch((err) => ({ answer: "", edits: null, error: `couldn't answer: ${errorText(err)}` })).then((result) => this.deliver(file, id, result)).finally(() => setPillStatus(id, null));
  }
  async ask(id, request, context, title) {
    const { url, headers, body } = buildRequest(this.settings, request, context, title);
    let next = body;
    let blocks = [];
    for (let round = 0; round < 4; round++) {
      const reply = await this.call(url, headers, next, (status) => setPillStatus(id, status));
      blocks = blocks.concat(reply.blocks);
      if (reply.stopReason === "refusal") throw new Error("Claude declined this request.");
      if (reply.stopReason !== "pause_turn") return resultFrom(blocks, reply.stopReason ?? "", this.settings.showSources);
      next = resumeBody(body, blocks);
    }
    throw new Error("the web search ran too long. Try a narrower request.");
  }
  // Streams the reply, so a long search or a long think never sits silent
  // long enough to time out. If streaming can't start, falls back to one
  // ordinary request.
  async call(url, headers, body, onStatus) {
    const ctl = new AbortController();
    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...body, stream: true }), signal: ctl.signal });
    } catch {
      return this.callOnce(url, headers, body);
    }
    if (!res.ok) {
      let json = null;
      try {
        json = await res.json();
      } catch {
      }
      throw new Error(errorMessage(res.status, json));
    }
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
      const json = checkResponse(res.status, await res.json());
      return { blocks: json.content ?? [], stopReason: json.stop_reason ?? null };
    }
    const parser = new StreamParser(onStatus);
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
      for (; ; ) {
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
  async callOnce(url, headers, body) {
    const res = await (0, import_obsidian3.requestUrl)({ url, method: "POST", headers, body: JSON.stringify(body), throw: false });
    let json = null;
    try {
      json = res.json;
    } catch {
    }
    checkResponse(res.status, json);
    return { blocks: json.content ?? [], stopReason: json.stop_reason ?? null };
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
  // Finishes a tag: the answer takes its place, or the edits are made and it
  // goes away, or on failure it comes back as the plain text you typed. Uses
  // the open editor when it can, so your typing isn't disturbed and one undo
  // reverts the whole thing; otherwise edits the file directly.
  async deliver(file, id, result) {
    const tagWord = this.settings.tagWord;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof import_obsidian3.MarkdownView) || view.file !== file || view.getMode() !== "source") continue;
      const plan2 = planChanges(view.editor.getValue(), id, result, tagWord);
      if (!plan2) continue;
      const undoable = this.applyPlan(view.editor, plan2);
      return this.report(plan2, result, undoable);
    }
    let plan = null;
    await this.app.vault.process(file, (text) => {
      plan = planChanges(text, id, result, tagWord);
      return plan ? finalText(text, plan) : text;
    });
    if (plan) this.report(plan, result, false);
    else new import_obsidian3.Notice("Inline AI: an answer arrived, but its thinking line was deleted, so it was dropped.");
  }
  // Applies a plan in the editor. Returns whether one undo reverts it to the
  // plain tag you typed.
  applyPlan(editor, plan) {
    const cm = editor.cm;
    this.delivering = true;
    try {
      if (cm && typeof cm.dispatch === "function") {
        cm.dispatch({ changes: plan.restore, annotations: import_state2.Transaction.addToHistory.of(false) });
        if (plan.changes.length) cm.dispatch({ changes: mapThrough(plan.changes, plan.restore), annotations: import_commands.isolateHistory.of("full") });
        return true;
      }
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
  report(plan, result, undoable) {
    if (plan.failure) {
      new import_obsidian3.Notice(`Inline AI ${plan.failure} Your tag is back as text: tap at its end and press Enter to send it again.`, 15e3);
    } else if (plan.edited) {
      const what = result.note || `Edited ${plural(plan.edited, "passage")}.`;
      new import_obsidian3.Notice(`Inline AI: ${what}${/[.!?]$/.test(what) ? "" : "."}${undoable ? " Undo reverts it." : ""}`, 8e3);
    }
    if (result.searchFailed && !plan.failure) {
      new import_obsidian3.Notice(`Inline AI: web search didn't work this time (${result.searchFailed.replace(/_/g, " ")}), so Claude answered without it.`, 1e4);
    }
  }
};
var IDLE_LIMIT_MS = 12e4;
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
function errorText(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timed? ?out/i.test(msg)) return "the request timed out.";
  if (/failed to fetch|load failed|network|offline|ERR_/i.test(msg)) return `couldn't reach Anthropic (${msg}). Check your connection.`;
  return msg;
}
