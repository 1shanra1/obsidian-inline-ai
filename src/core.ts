// The plugin's logic, kept free of Obsidian imports so it can be tested in Node.

export interface Tag {
  start: number; // where the tag word starts on the line
  request: string; // what you asked for
}

export interface ApiSettings {
  apiKey: string;
  model: string;
  effort: string;
  maxTokens: number;
  refusalFallback: boolean;
  webSearch: boolean;
  allowEdits: boolean;
}

/** One change the AI wants made: an exact passage of the note and its new text. */
export interface Edit {
  find: string;
  replace: string;
}

/** A change to the note's text, by offsets into the text before any change. */
export interface Change {
  from: number;
  to: number;
  insert: string;
}

/** What a tag comes back with: text to put at the tag, and edits elsewhere if any. */
export interface Result {
  answer: string;
  edits: Edit[] | null;
}

// The thinking pill. styles.css animates it; the answer replaces it.
const THINKING = '<span class="inline-ai-thinking"><span>Thinking</span></span>';
// Also matches the plain-text placeholder from 0.1.0.
const THINKING_RE = '(?:<span class="inline-ai-thinking"><span>[^<]*</span></span>| ⏳ \\*AI is thinking…\\*)?';
const HERE = "<<<AI_TAG_HERE>>>";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds a tag that hasn't been sent yet, like "@ai a table of planets".
 * The tag word has to start the line or follow a space, so "me@ai.com" doesn't count.
 * A sent tag sits inside a comment ("%%@ai ...%%"), so it doesn't match again.
 */
export function findTag(line: string, tagWord = "@ai"): Tag | null {
  const re = new RegExp(`(^|\\s)${escapeRegex(tagWord)}\\s+(\\S.*?)\\s*$`);
  const m = re.exec(line);
  if (!m) return null;
  return { start: m.index + m[1].length, request: m[2] };
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function marker(id: string): string {
  return `%%ai:${id}%%`;
}

/**
 * The text that replaces the tag line when a tag is sent: the tag hidden in a
 * comment, then a "thinking" line carrying a hidden id. The answer replaces
 * the thinking line later, wherever it has moved to by then.
 */
export function dispatchText(line: string, tag: Tag, id: string): string {
  const hidden = line.slice(0, tag.start) + "%%" + line.slice(tag.start).trimEnd() + "%%";
  return hidden + "\n" + marker(id) + THINKING;
}

export function findPlaceholder(lines: string[], id: string): number {
  return lines.findIndex((l) => l.includes(marker(id)));
}

/**
 * The new text for the thinking line at index i. Keeps anything you typed on
 * that line, and adds blank lines around the answer so tables and other
 * blocks render.
 */
export function replacementFor(lines: string[], i: number, id: string, answer: string): string {
  const line = lines[i];
  const re = new RegExp(escapeRegex(marker(id)) + THINKING_RE);
  const m = re.exec(line)!;
  const before = line.slice(0, m.index);
  const after = line.slice(m.index + m[0].length).trimStart();

  let block = answer.trim();
  const above = before.trim() !== "" ? before : i > 0 ? lines[i - 1] : "";
  const below = after.trim() !== "" ? after : i < lines.length - 1 ? lines[i + 1] : "";
  if (above.trim() !== "") block = "\n" + block;
  if (below.trim() !== "") block = block + "\n";

  return (before.trim() !== "" ? before + "\n" : "") + block + (after.trim() !== "" ? "\n" + after : "");
}

export interface MarkerRanges {
  hide: [number, number][]; // "%%" around a sent tag
  tag: [number, number][]; // the sent tag's text, shown as a chip
  pill: [number, number][]; // a thinking placeholder, drawn as the animated pill
}

/**
 * Where the plugin's markers sit in a piece of text, so the editor can hide
 * them. Offsets are relative to the text passed in.
 */
export function markerRanges(text: string, tagWord = "@ai"): MarkerRanges {
  const out: MarkerRanges = { hide: [], tag: [], pill: [] };
  const tagRe = new RegExp(`%%(${escapeRegex(tagWord)}\\s[^\\n]*?)%%`, "g");
  for (let m; (m = tagRe.exec(text)); ) {
    const start = m.index;
    const end = start + m[0].length;
    out.hide.push([start, start + 2], [end - 2, end]);
    out.tag.push([start + 2, end - 2]);
  }
  const pillRe = new RegExp("%%ai:[a-z0-9]+%%" + THINKING_RE, "g");
  for (let m; (m = pillRe.exec(text)); ) out.pill.push([m.index, m.index + m[0].length]);
  return out;
}

/** Puts the answer where the thinking line is. Returns null if that line is gone. */
export function applyAnswer(text: string, id: string, answer: string): string | null {
  const lines = text.split("\n");
  const i = findPlaceholder(lines, id);
  if (i < 0) return null;
  lines[i] = replacementFor(lines, i, id, answer);
  return lines.join("\n");
}

/**
 * The whole note with the tag's spot marked. Other tags still thinking are
 * left out, so they don't distract.
 */
export function buildContext(text: string, at: number): string {
  const strip = (t: string) => t.replace(/%%ai:[a-z0-9]+%%(?:<span class="inline-ai-thinking"><span>[^<]*<\/span><\/span>)?/g, "");
  return strip(text.slice(0, at)) + HERE + strip(text.slice(at));
}

const BASE_PROMPT = `You are a writing partner inside the user's Obsidian note. While writing, they typed a quick inline request. Your reply is inserted at that spot, marked ${HERE}, and becomes part of the note. The request itself sits in a comment just above the spot.

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

const EDIT_PROMPT = `Changing the note:
- When the request asks to change text that is already in the note (fix, correct, update, rewrite, shorten, reformat, "make this ..."), call edit_note instead of writing a reply.
- Each edit's find is copied character for character from the note, just long enough to appear only once, and covers only the passage that changes. Never include the request comment or ${HERE}.
- Call edit_note at most once, with every edit, as your last step. Its note is optional: one short line saying what you changed, shown at the spot. Write nothing else.
- If the request asks a question or wants new content, reply as usual and don't edit.`;

export function systemPrompt(allowEdits = true): string {
  return allowEdits ? BASE_PROMPT + "\n\n" + EDIT_PROMPT : BASE_PROMPT;
}

/** The client tool Claude calls to change existing text in the note. */
export const EDIT_TOOL = {
  name: "edit_note",
  description:
    "Change text that is already in the note. Each edit replaces one exact passage with new text. All edits are applied together as one undoable change, or not at all if any passage can't be found exactly once.",
  input_schema: {
    type: "object",
    properties: {
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            find: { type: "string", description: "Exact text from the note that appears only once." },
            replace: { type: "string", description: "The new text for that passage." },
          },
          required: ["find", "replace"],
        },
      },
      note: { type: "string", description: "Optional: one short line saying what changed, shown where the request was made." },
    },
    required: ["edits"],
  },
};

// Models that accept server-side refusal fallbacks.
const FALLBACK_MODELS = /^claude-(opus-5|fable-5|mythos-5|sonnet-5-5)/;

// Models whose web search filters results itself (the newer tool version).
const DYNAMIC_SEARCH_MODELS = /^claude-(opus-5|opus-4-[678]|fable-5|mythos-5|sonnet-5|sonnet-4-6)/;

export function buildRequest(s: ApiSettings, request: string, context: string, title = "") {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": s.apiKey,
    "anthropic-version": "2026-10-21",
    "anthropic-dangerous-direct-browser-access": "true",
  };
  const body: Record<string, unknown> = {
    model: s.model,
    max_tokens: s.maxTokens,
    system: systemPrompt(s.allowEdits),
    output_config: { effort: s.effort },
    messages: [{ role: "user", content: `<note title="${title.replace(/"/g, "'")}">\n${context}\n</note>\n\nRequest: ${request}` }],
  };
  const tools: unknown[] = [];
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

/** A plain-words reason for a failed API call. */
export function errorMessage(status: number, json: any): string {
  const type = json?.error?.type;
  const msg: string | undefined = json?.error?.message;
  if (status === 401 || type === "authentication_error") return "Anthropic didn't accept the API key. Check it in Inline AI's settings.";
  if (status === 429 || type === "rate_limit_error") return "hit the API rate limit. Wait a moment and tag again.";
  if (status === 529 || type === "overloaded_error") return "Anthropic is overloaded right now. Tag again in a minute.";
  if (status === 404 || type === "not_found_error") return `${msg ?? "not found"}. Check the model name in Inline AI's settings.`;
  return msg ?? `the request failed (HTTP ${status}).`;
}

/** Throws a readable error if the API call failed or Claude declined. */
export function checkResponse(status: number, json: any): any {
  if (status >= 400 || !json || json.type === "error") throw new Error(errorMessage(status, json));
  if (json.stop_reason === "refusal") {
    throw new Error("Claude declined this request.");
  }
  return json;
}

/**
 * A long web search can pause the turn. This is the next request: the same
 * one, plus everything Claude has produced so far, so the server picks up
 * where it stopped.
 */
export function resumeBody(body: Record<string, any>, contentSoFar: unknown[]): Record<string, any> {
  return { ...body, messages: [body.messages[0], { role: "assistant", content: contentSoFar }] };
}

/**
 * The Markdown to insert, from the reply's content blocks. With showSources,
 * a cited passage gets a short link to its source (at most three in all).
 */
export function answerFrom(blocks: any[], stopReason: string, showSources = false): string {
  const used = new Set<string>();
  let text = "";
  for (const b of blocks) {
    if (b.type !== "text") continue;
    text += b.text;
    const c = (b.citations ?? []).find((c: any) => c.url && !used.has(c.url));
    if (showSources && c && used.size < 3) {
      used.add(c.url);
      text += ` ([${domainOf(c.url)}](${c.url.replace(/\)/g, "%29").replace(/ /g, "%20")}))`;
    }
  }
  let out = unwrapFence(text);
  if (stopReason === "max_tokens") out += "\n\n*(cut off: hit the max tokens setting)*";
  return out;
}

function domainOf(url: string): string {
  const m = /^https?:\/\/(?:www\.)?([^/?#]+)/.exec(url);
  return m ? m[1] : "source";
}

/** One reply, start to finish: check it, then turn it into Markdown. */
export function parseResponse(status: number, json: any, showSources = false): string {
  checkResponse(status, json);
  return answerFrom(json.content ?? [], json.stop_reason, showSources);
}

/**
 * What the reply asks for: edits if Claude called edit_note (its note goes at
 * the tag), otherwise the text to insert.
 */
export function resultFrom(blocks: any[], stopReason: string, showSources = false): Result {
  const call = blocks.find((b) => b?.type === "tool_use" && b.name === EDIT_TOOL.name);
  if (!call) return { answer: answerFrom(blocks, stopReason, showSources), edits: null };
  const input = call.input;
  const ok = input && Array.isArray(input.edits) && input.edits.every((e: any) => e && typeof e.find === "string" && typeof e.replace === "string");
  if (!ok) throw new Error(stopReason === "max_tokens" ? "the edit was cut off by the max tokens setting." : "Claude's edit came back incomplete.");
  return {
    answer: typeof input.note === "string" ? input.note.trim() : "",
    edits: input.edits.map((e: Edit) => ({ find: e.find, replace: e.replace })),
  };
}

function editFailure(reason: string): string {
  return `> [!warning] Inline AI couldn't make the edit: ${reason} Nothing was changed, so tag again.`;
}

/**
 * Checks Claude's edits against the note as it is now. Returns their ranges,
 * or a reason they can't be applied. Each passage must appear exactly once,
 * and none may touch the plugin's markers or the thinking line.
 */
function locateEdits(text: string, edits: Edit[], protectedRanges: [number, number][]): Change[] | string {
  const out: Change[] = [];
  for (const e of edits) {
    if (!e.find) return "an edit didn't say which text to change.";
    if (e.find.includes(HERE) || e.find.includes("%%ai:") || e.replace.includes("%%ai:")) return "an edit reached into the request itself.";
    const at = text.indexOf(e.find);
    if (at < 0) return "the text it meant to change isn't in the note any more.";
    if (text.indexOf(e.find, at + 1) >= 0) return "the text it meant to change appears more than once.";
    const end = at + e.find.length;
    if (protectedRanges.some(([p, q]) => at < q && p < end)) return "an edit reached into the request itself.";
    out.push({ from: at, to: end, insert: e.replace });
  }
  out.sort((a, b) => a.from - b.from);
  for (let k = 1; k < out.length; k++) if (out[k].from < out[k - 1].to) return "two of its edits overlapped.";
  return out;
}

/**
 * Every change a result makes to the note, by offsets into the note as it is
 * now, so they can go in as one undoable edit. The thinking line becomes the
 * answer (or goes away after an edit with no note). If any edit can't be
 * applied, none are, and a warning takes the thinking line's place.
 * Returns null if the thinking line has been deleted.
 */
export function planChanges(text: string, id: string, result: Result, tagWord = "@ai"): { changes: Change[]; edited: number } | null {
  const lines = text.split("\n");
  const i = findPlaceholder(lines, id);
  if (i < 0) return null;
  const lineStart = lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
  const lineEnd = lineStart + lines[i].length;
  const atTag = (answer: string): Change => ({ from: lineStart, to: lineEnd, insert: replacementFor(lines, i, id, answer) });

  if (!result.edits) return { changes: [atTag(result.answer)], edited: 0 };

  const r = markerRanges(text, tagWord);
  const protectedRanges: [number, number][] = [
    [Math.max(0, lineStart - 1), lineEnd + 1], // the thinking line and the line breaks around it
    ...r.tag.map(([a, b]): [number, number] => [a - 2, b + 2]),
    ...r.pill,
  ];
  const located = locateEdits(text, result.edits, protectedRanges);
  if (typeof located === "string") return { changes: [atTag(editFailure(located))], edited: 0 };

  if (result.answer.trim()) return { changes: [...located, atTag(result.answer)], edited: located.length };
  return { changes: [...located, removeThinkingLine(lines, i, id, lineStart, lineEnd)], edited: located.length };
}

// Removes the thinking line, keeping anything typed on it.
function removeThinkingLine(lines: string[], i: number, id: string, lineStart: number, lineEnd: number): Change {
  const line = lines[i];
  const m = new RegExp(escapeRegex(marker(id)) + THINKING_RE).exec(line)!;
  const kept = [line.slice(0, m.index).trimEnd(), line.slice(m.index + m[0].length).trim()].filter((t) => t !== "").join("\n");
  if (kept) return { from: lineStart, to: lineEnd, insert: kept };
  if (i < lines.length - 1) return { from: lineStart, to: lineEnd + 1, insert: "" };
  return { from: Math.max(0, lineStart - 1), to: lineEnd, insert: "" };
}

/** Applies changes made by planChanges to the text they were planned on. */
export function applyChanges(text: string, changes: Change[]): string {
  let out = text;
  for (const c of [...changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

/**
 * Rebuilds a streamed reply from its server-sent events, so it ends up the
 * same as a non-streamed one. onStatus hears what Claude is doing now.
 */
export class StreamParser {
  blocks: any[] = [];
  stopReason: string | null = null;
  private buf = "";
  private json = new Map<number, string>();
  private status = "";

  private onStatus: (status: string) => void;

  constructor(onStatus: (status: string) => void = () => {}) {
    this.onStatus = onStatus;
  }

  push(chunk: string) {
    this.buf += chunk.replace(/\r/g, "");
    for (let k; (k = this.buf.indexOf("\n\n")) >= 0; ) {
      const raw = this.buf.slice(0, k);
      this.buf = this.buf.slice(k + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) this.event(JSON.parse(data));
    }
  }

  /** The reply's content blocks, once the stream has ended. */
  finish(): any[] {
    if (this.buf.trim()) this.push("\n\n");
    for (const i of [...this.json.keys()]) this.closeBlock(i);
    return this.blocks.filter(Boolean);
  }

  private say(status: string) {
    if (status === this.status) return;
    this.status = status;
    this.onStatus(status);
  }

  private event(e: any) {
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
        else if (d.type === "citations_delta") (b.citations ??= []).push(d.citation);
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

  private closeBlock(i: number) {
    if (!this.json.has(i)) return;
    const raw = this.json.get(i)!;
    this.json.delete(i);
    const b = this.blocks[i];
    if (!raw) return; // input arrived whole in content_block_start
    try {
      b.input = JSON.parse(raw);
    } catch {
      b.input = null; // cut off mid-way; resultFrom reports it
    }
  }
}

/** Drops a ```markdown fence if the model wrapped its whole answer in one. */
export function unwrapFence(text: string): string {
  const m = /^\s*```(?:markdown|md)[ \t]*\n([\s\S]*?)\n```\s*$/.exec(text);
  return m ? m[1] : text;
}

/**
 * Pulls SVG code blocks out of an answer so they can be saved as files.
 * Each one is replaced with a token like {{svg:0}}.
 */
export function extractSvgs(md: string): { md: string; svgs: string[] } {
  const svgs: string[] = [];
  const out = md.replace(/```(?:svg|xml|html)?[ \t]*\n\s*(<svg[\s\S]*?<\/svg>)\s*\n```/g, (_all, svg: string) => {
    svgs.push(svg);
    return `{{svg:${svgs.length - 1}}}`;
  });
  return { md: out, svgs };
}
