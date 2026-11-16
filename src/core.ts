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

export const SYSTEM_PROMPT = `You are a writing partner inside the user's Obsidian note. While writing, they typed a quick inline request. Your reply is inserted at that spot, marked ${HERE}, and becomes part of the note. The request itself sits in a comment just above the spot.

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
    system: SYSTEM_PROMPT,
    output_config: { effort: s.effort },
    messages: [{ role: "user", content: `<note title="${title.replace(/"/g, "'")}">\n${context}\n</note>\n\nRequest: ${request}` }],
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

/** Throws a readable error if the API call failed or Claude declined. */
export function checkResponse(status: number, json: any): any {
  if (status >= 400 || !json || json.type === "error") {
    const msg = json?.error?.message ?? `request failed (HTTP ${status})`;
    throw new Error(msg);
  }
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
