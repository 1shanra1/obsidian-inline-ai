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
}

const THINKING = " ⏳ *AI is thinking…*";
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
  const re = new RegExp(escapeRegex(marker(id)) + "(" + escapeRegex(THINKING) + ")?");
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

/** Puts the answer where the thinking line is. Returns null if that line is gone. */
export function applyAnswer(text: string, id: string, answer: string): string | null {
  const lines = text.split("\n");
  const i = findPlaceholder(lines, id);
  if (i < 0) return null;
  lines[i] = replacementFor(lines, i, id, answer);
  return lines.join("\n");
}

/** The note around the tag, with the tag's spot marked, cut to about maxChars. */
export function buildContext(text: string, at: number, maxChars: number): string {
  const start = Math.max(0, at - Math.floor(maxChars * 0.75));
  const end = Math.min(text.length, at + (maxChars - (at - start)));
  return (start > 0 ? "…" : "") + text.slice(start, at) + HERE + text.slice(at, end) + (end < text.length ? "…" : "");
}

export const SYSTEM_PROMPT = `You write content that is inserted straight into the user's Obsidian note, at the spot where they typed an inline request while writing. The note is given with ${HERE} marking that spot.

Rules:
- Output only the content to insert, in Obsidian-flavored Markdown. No preamble, no sign-off, don't repeat the request, and don't wrap the whole answer in a code block.
- Fit the note: its language, tone and level of detail. Keep it short unless the request asks for more.
- Tables: Markdown tables.
- Diagrams, flowcharts, timelines, graphs and charts: a \`\`\`mermaid code block (Obsidian draws Mermaid; use xychart-beta for bar or line charts and pie for pie charts).
- Images or illustrations: one \`\`\`svg code block holding a complete standalone SVG with xmlns and viewBox. It is saved as an image file.
- Math: LaTeX between $ or $$.
- When numbers come from your memory, say if they are approximate or may be out of date.`;

// Models that accept server-side refusal fallbacks.
const FALLBACK_MODELS = /^claude-(opus-5|fable-5|mythos-5|sonnet-5-5)/;

export function buildRequest(s: ApiSettings, request: string, context: string) {
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
    messages: [{ role: "user", content: `<note>\n${context}\n</note>\n\nRequest: ${request}` }],
  };
  if (s.refusalFallback && FALLBACK_MODELS.test(s.model)) {
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    body.fallbacks = "default";
  }
  return { url: "https://api.anthropic.com/v1/messages", headers, body };
}

/** Turns the API's reply into Markdown, or throws an error with a readable message. */
export function parseResponse(status: number, json: any): string {
  if (status >= 400 || !json || json.type === "error") {
    const msg = json?.error?.message ?? `request failed (HTTP ${status})`;
    throw new Error(msg);
  }
  if (json.stop_reason === "refusal") {
    throw new Error("Claude declined this request.");
  }
  const text = (json.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  let out = unwrapFence(text);
  if (json.stop_reason === "max_tokens") out += "\n\n*(cut off: hit the max tokens setting)*";
  return out;
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
