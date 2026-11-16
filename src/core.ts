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
  maxSearches: number; // 0 means no limit
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

/** What a tag comes back with. */
export interface Result {
  answer: string; // text that takes the tag's place
  edits: Edit[] | null; // changes elsewhere in the note, if Claude asked for any
  note?: string; // a few words on what an edit changed, shown as a pop-up
  error?: string; // why it failed; the tag comes back as plain text
  searchErrors?: string[]; // error codes from web searches that didn't work
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
  return hidden + "\n" + quoteOf(line) + marker(id) + THINKING;
}

/** The "> " a line starts with when it's inside a quote or card, else "". */
export function quoteOf(line: string): string {
  return /^(?:[ \t]*>)+[ \t]?/.exec(line)?.[0] ?? "";
}

/** Whether line i sits inside an answer card (a callout starting "> [!ai]"). */
export function inCard(lines: string[], i: number): boolean {
  for (let n = i; n >= 0 && quoteOf(lines[n]); n--) {
    if (/^[ \t]*>[ \t]*\[!ai\]/i.test(lines[n])) return true;
  }
  return false;
}

// A line that holds nothing but quote markers, like ">".
function quoteOnly(line: string): boolean {
  return /^(?:[ \t]*>)*[ \t]*$/.test(line);
}

export function findPlaceholder(lines: string[], id: string): number {
  return lines.findIndex((l) => l.includes(marker(id)));
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

/**
 * A tag in flight: its hidden request line and the thinking line under it.
 * When the tag is done, the whole slot is replaced, so the request doesn't
 * linger in the note.
 */
export interface Slot {
  from: number; // start of the request line (or the thinking line, if the request line is gone)
  to: number; // end of the thinking line
  hereFrom: number; // where the request comment starts
  hereTo: number; // where the thinking pill ends
  keptBefore: string[]; // anything you'd typed before the tag or the pill on those lines
  keptAfter: string; // anything typed after the pill
  restore: string; // the slot as plain text with the tag unsent, e.g. "@ai a table"
  above: string; // the line just above the slot
  below: string; // the line just below it
  quote: string; // "> " when the tag was typed inside a quote or card
  card: boolean; // typed inside an answer card: a follow-up to it
  question: string; // the request, without the tag word
}

export function findSlot(text: string, id: string, tagWord = "@ai"): Slot | null {
  const lines = text.split("\n");
  const i = findPlaceholder(lines, id);
  if (i < 0) return null;
  const starts: number[] = [];
  let o = 0;
  for (const l of lines) {
    starts.push(o);
    o += l.length + 1;
  }
  const line = lines[i];
  const m = new RegExp(escapeRegex(marker(id)) + THINKING_RE).exec(line)!;
  const beforePill = line.slice(0, m.index).trimEnd();
  const afterPill = line.slice(m.index + m[0].length).trim();
  const tagM = i > 0 ? new RegExp(`%%(${escapeRegex(tagWord)}\\s[^\\n]*?)%%\\s*$`).exec(lines[i - 1]) : null;
  const first = tagM ? i - 1 : i;
  const beforeTag = tagM ? lines[i - 1].slice(0, tagM.index).trimEnd() : "";
  const quote = quoteOf(lines[first]);
  const keep = (t: string) => t.trim() !== "" && !(quote && quoteOnly(t));
  return {
    from: starts[first],
    to: starts[i] + line.length,
    hereFrom: tagM ? starts[i - 1] + tagM.index : starts[i] + m.index,
    hereTo: starts[i] + m.index + m[0].length,
    keptBefore: [beforeTag, beforePill].filter(keep),
    keptAfter: afterPill,
    restore: [tagM ? lines[i - 1].slice(0, tagM.index) + tagM[1] : "", beforePill, afterPill].filter(keep).join("\n"),
    above: first > 0 ? lines[first - 1] : "",
    below: i < lines.length - 1 ? lines[i + 1] : "",
    quote,
    card: quote !== "" && inCard(lines, first),
    question: tagM ? tagM[1].slice(tagWord.length).trim() : "",
  };
}

function allSlots(text: string, tagWord: string): { id: string; slot: Slot }[] {
  const out: { id: string; slot: Slot }[] = [];
  for (const m of text.matchAll(/%%ai:([a-z0-9]+)%%/g)) {
    const slot = findSlot(text, m[1], tagWord);
    if (slot) out.push({ id: m[1], slot });
  }
  return out;
}

// The text that takes a finished slot's place: the answer, with blank lines
// around it so tables and other blocks render, plus anything you'd typed there.
function slotText(slot: Slot, answer: string): string {
  if (!answer.trim()) return [...slot.keptBefore, slot.keptAfter].filter((t) => t !== "").join("\n");
  if (slot.quote) return quotedSlotText(slot, answer);
  let block = answer.trim();
  const above = slot.keptBefore.length ? slot.keptBefore[slot.keptBefore.length - 1] : slot.above;
  const below = slot.keptAfter || slot.below;
  if (above.trim() !== "") block = "\n" + block;
  if (below.trim() !== "") block = block + "\n";
  return [...slot.keptBefore, block, ...(slot.keptAfter ? [slot.keptAfter] : [])].join("\n");
}

// Inside a card or quote, the answer stays inside it: every line keeps the
// "> ". In a card, the question stays too, as a "> > question" line, so the
// card reads as a short conversation.
function quotedSlotText(slot: Slot, answer: string): string {
  const q = slot.quote.endsWith(" ") ? slot.quote : slot.quote + " ";
  const blank = q.trimEnd();
  const body = answer.trim().split("\n").map((l) => (l.trim() ? q + l : blank));
  const lines = slot.card && slot.question ? [q + "> " + slot.question, blank, ...body] : body;
  const above = slot.keptBefore.length ? slot.keptBefore[slot.keptBefore.length - 1] : slot.above;
  const below = slot.keptAfter || slot.below;
  if (quoteOf(above) && !quoteOnly(above)) lines.unshift(blank);
  if (slot.keptAfter || (quoteOf(below) && !quoteOnly(below))) lines.push(blank);
  return [...slot.keptBefore, ...lines, ...(slot.keptAfter ? [slot.keptAfter] : [])].join("\n");
}

/**
 * The whole note, with this tag's request and pill replaced by a marker for
 * the spot. Other tags still in flight are left out, so they don't distract
 * and can't be edited. (The request itself is sent separately.)
 */
export function buildContext(text: string, id: string, tagWord = "@ai"): string {
  const cuts = allSlots(text, tagWord)
    .map(({ id: other, slot }) => ({ from: slot.hereFrom, to: slot.hereTo, insert: other === id ? HERE : "" }));
  return applyChanges(text, cuts);
}

const BASE_PROMPT = `You are a reading companion inside the user's Obsidian note. They take notes while reading books, and they want help understanding and remembering what they read: explanations, numbers and facts, answers to their questions, examples, and links between ideas. While writing, they typed a quick request. Your reply takes the place of the spot where they typed it, marked ${HERE}, and becomes part of the note. The request is given after the note.

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

Follow-ups in a card:
- An answer card is a block of lines starting with "> " under a "> [!ai]" title line. If ${HERE} is inside one, the request is a follow-up to that card, and the card is your conversation so far: your earlier answer, then any earlier follow-ups, each a "> > question" line with its answer under it.
- Answer only the new question. Build on what the card already says without repeating it, keep it short, and give no Title line. Write plain Markdown without the "> "; the app adds it.

Web search, when available:
- Use it when the answer depends on facts, figures, dates or anything recent. Skip it for writing, rewording or brainstorming.
- Use what you find without describing the search. If a figure is uncertain, say so in a few words.`;

const EDIT_PROMPT = `Changing the note:
- When the request asks to change text that is already in the note (fix, correct, update, rewrite, shorten, reformat, "make this ..."), call edit_note instead of writing a reply.
- Each edit's find is copied character for character from the note, just long enough to appear only once, and covers only the passage that changes. Never include ${HERE}.
- To remove something, replace it with an empty string. Blank lines left behind are tidied up for you.
- Lines like %%@ai ...%% are earlier requests whose answers are already in the note. When you remove what one asked for, remove its line too.
- Call edit_note at most once, with every edit, as your last step. Its note is a few words on what you changed, shown briefly as a pop-up, not added to the note. Write nothing else.
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
      note: { type: "string", description: "A few words on what changed, shown as a brief pop-up." },
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
    tools.push(s.maxSearches > 0 ? { type, name: "web_search", max_uses: s.maxSearches } : { type, name: "web_search" });
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
  if (status === 429 || type === "rate_limit_error") return "hit the API rate limit. Wait a moment and try again.";
  if (status === 529 || type === "overloaded_error") return "Anthropic is overloaded right now. Try again in a minute.";
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
 * What the reply asks for: edits if Claude called edit_note, otherwise the
 * text to insert. Notes whether a web search failed.
 */
export function resultFrom(blocks: any[], stopReason: string, showSources = false): Result {
  const errors = toolErrors(blocks);
  const searchErrors = errors.length ? errors : undefined;
  const call = blocks.find((b) => b?.type === "tool_use" && b.name === EDIT_TOOL.name);
  if (!call) return { answer: answerFrom(blocks, stopReason, showSources), edits: null, searchErrors };
  const input = call.input;
  const ok = input && Array.isArray(input.edits) && input.edits.every((e: any) => e && typeof e.find === "string" && typeof e.replace === "string");
  if (!ok) throw new Error(stopReason === "max_tokens" ? "the edit was cut off by the max tokens setting." : "Claude's edit came back incomplete.");
  return {
    answer: "",
    edits: input.edits.map((e: Edit) => ({ find: e.find, replace: e.replace })),
    note: typeof input.note === "string" ? input.note.trim() : "",
    searchErrors,
  };
}

/**
 * Every error code reported by a server tool in the reply, such as
 * "max_uses_exceeded". Searches can run inside the code Claude writes to
 * filter results, where errors sit deeper, so this looks everywhere except
 * Claude's own text.
 */
export function toolErrors(blocks: any[]): string[] {
  const out = new Set<string>();
  const walk = (x: any) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== "object") return;
    if (typeof x.error_code === "string") out.add(x.error_code);
    for (const v of Object.values(x)) walk(v);
  };
  for (const b of blocks) if (b?.type !== "text" && b?.type !== "thinking") walk(b);
  return [...out];
}

/** One line per content block, for the debug log. Never includes the note. */
export function describeBlocks(blocks: any[]): string[] {
  return blocks.map((b) => {
    if (!b || typeof b !== "object") return String(b);
    if (b.type === "text") return `text (${(b.text ?? "").length} chars${b.citations?.length ? `, ${b.citations.length} citations` : ""})`;
    if (b.type === "server_tool_use" || b.type === "tool_use") {
      const q = b.input?.query ? ` "${String(b.input.query).slice(0, 120)}"` : b.input?.code ? " (code)" : "";
      return `${b.type} ${b.name ?? "?"}${q}`;
    }
    const errs = toolErrors([b]);
    if (errs.length) return `${b.type}: error ${errs.join(", ")}`;
    if (Array.isArray(b.content)) return `${b.type} (${b.content.length} items)`;
    return b.type;
  });
}

/** Plain words for a web search error code. */
export function searchErrorText(code: string): string {
  const known: Record<string, string> = {
    max_uses_exceeded: "it hit the searches-per-tag limit in Inline AI's settings",
    too_many_requests: "Anthropic's search was rate limited",
    unavailable: "the search service was unavailable",
    query_too_long: "a search query was too long",
    invalid_input: "a search query was invalid",
  };
  return known[code] ?? code.replace(/_/g, " ");
}

/**
 * Checks Claude's edits against the note as it is now. Returns their ranges,
 * or a reason they can't be applied. Each passage must appear exactly once,
 * and none may touch a tag that's still in flight.
 */
function locateEdits(text: string, edits: Edit[], protectedRanges: [number, number][]): Change[] | string {
  const out: Change[] = [];
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

const WS = /[ \t\n]/;
const BLANK_LINE = /\n[ \t]*\n/;

/**
 * Where a change removes text, also removes the blank lines it leaves behind,
 * so at most one blank line separates what's left (none if there was none).
 */
export function tidyGaps(text: string, changes: Change[]): Change[] {
  const sorted = [...changes].sort((a, b) => a.from - b.from);
  type Gap = Change & { blank: boolean; para: boolean };
  const out: Gap[] = [];
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
    const left = text.slice(L, c.from) + /^\s*/.exec(removed)![0];
    const right = /\s*$/.exec(removed)![0] + text.slice(c.to, R);
    if (!(left + c.insert + right).includes("\n")) return out.push({ ...c, blank: false, para: false }); // within a line: leave as is
    out.push({ from: L, to: R, insert: "", blank: true, para: BLANK_LINE.test(left) || BLANK_LINE.test(right) });
  });
  // Neighbouring removals become one, then each gets its separator.
  const merged: Gap[] = [];
  for (const g of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.blank && g.blank && g.from <= prev.to) {
      prev.to = Math.max(prev.to, g.to);
      prev.para = prev.para || g.para || BLANK_LINE.test(text.slice(prev.to, g.from));
    } else merged.push({ ...g });
  }
  return merged.map((g) => {
    if (!g.blank) return { from: g.from, to: g.to, insert: g.insert };
    const sep = g.from === 0 ? "" : g.to === text.length ? (text.endsWith("\n") ? "\n" : "") : g.para ? "\n\n" : "\n";
    return { from: g.from, to: g.to, insert: sep };
  });
}

/**
 * How to finish a tag. First the slot goes back to plain text (restore),
 * kept out of undo history so that undoing the answer brings back the tag
 * you typed; then the changes, which are the answer or edits and are planned
 * on the text before restore (see mapThrough). On failure there are no
 * changes and the restored tag stays. Returns null if the thinking line has
 * been deleted.
 */
export interface Plan {
  restore: Change;
  changes: Change[];
  edited: number;
  failure?: string;
}

export function planChanges(text: string, id: string, result: Result, tagWord = "@ai"): Plan | null {
  const slot = findSlot(text, id, tagWord);
  if (!slot) return null;
  const restore: Change = { from: slot.from, to: slot.to, insert: slot.restore };
  if (result.error) return { restore, changes: [], edited: 0, failure: result.error };
  if (!result.edits) return { restore, changes: tidyGaps(text, [{ from: slot.from, to: slot.to, insert: slotText(slot, result.answer) }]), edited: 0 };

  const protectedRanges: [number, number][] = [
    [Math.max(0, slot.from - 1), slot.to + 1],
    ...allSlots(text, tagWord).map(({ slot: s }): [number, number] => [s.from, s.to]),
  ];
  const located = locateEdits(text, result.edits, protectedRanges);
  if (typeof located === "string") return { restore, changes: [], edited: 0, failure: `couldn't make the edit: ${located}` };
  const changes = tidyGaps(text, [...located, { from: slot.from, to: slot.to, insert: slotText(slot, "") }]);
  return { restore, changes, edited: located.length };
}

/** Moves changes planned on the text before `restore` onto the text after it. */
export function mapThrough(changes: Change[], r: Change): Change[] {
  const delta = r.insert.length - (r.to - r.from);
  const map = (p: number, end: boolean) => (p <= r.from ? p : p >= r.to ? p + delta : end ? r.from + r.insert.length : r.from);
  return changes.map((c) => ({ from: map(c.from, false), to: map(c.to, true), insert: c.insert }));
}

/** The note after a plan: what the editor shows once both steps are done. */
export function finalText(text: string, plan: Plan): string {
  return applyChanges(applyChanges(text, [plan.restore]), mapThrough(plan.changes, plan.restore));
}

/**
 * Tidies a note: tags that were interrupted (their pill isn't in flight) go
 * back to plain text so you can send them again, and request comments left
 * by earlier versions are removed.
 */
export function cleanupChanges(text: string, tagWord: string, isLive: (id: string) => boolean): Change[] {
  const changes: Change[] = [];
  const slots = allSlots(text, tagWord);
  for (const { id, slot } of slots) if (!isLive(id)) changes.push({ from: slot.from, to: slot.to, insert: slot.restore });
  const tagRe = new RegExp(`%%${escapeRegex(tagWord)}\\s[^\\n]*?%%`, "g");
  for (const m of text.matchAll(tagRe)) {
    const a = m.index!;
    const b = a + m[0].length;
    if (slots.some(({ slot }) => a >= slot.from && b <= slot.to)) continue;
    changes.push({ from: a, to: b, insert: "" });
  }
  return tidyGaps(text, changes);
}

/** Applies changes, all given by offsets into the same text. */
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
  usage: any = {};
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
      case "message_start":
        this.usage = { ...(e.message?.usage ?? {}) };
        return;
      case "message_delta":
        if (e.delta?.stop_reason) this.stopReason = e.delta.stop_reason;
        if (e.usage) this.usage = { ...this.usage, ...e.usage };
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

/**
 * Puts a longer answer in a card: a foldable Obsidian callout of type "ai",
 * titled by Claude's "Title:" line or, failing that, by the request. Short
 * answers stay plain text. With cards off, the title line is dropped.
 */
export function formatAnswer(answer: string, request: string, cards = true): string {
  const m = /^\s*Title:[ \t]*(.+?)[ \t]*(?:\n|$)/i.exec(answer);
  const body = (m ? answer.slice(m[0].length) : answer).trim();
  if (!cards || !body) return body;
  const long = body.length > 450 || body.split("\n").filter((l) => l.trim()).length > 4 || /^\s*(\||```|\$\$)/m.test(body);
  if (!m && !long) return body;
  const title = cardTitle(m ? m[1] : request);
  return [`> [!ai]+ ${title}`, ...body.split("\n").map((l) => (l.trim() ? "> " + l : ">"))].join("\n");
}

function cardTitle(text: string): string {
  let t = text.replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim().replace(/[.:;,!?]+$/, "");
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, "") + "…";
  return t.charAt(0).toUpperCase() + t.slice(1);
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
