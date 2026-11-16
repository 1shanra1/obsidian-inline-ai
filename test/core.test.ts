import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.ts";

// Sends the tag on line n the way the plugin does, and returns the new text.
function send(text: string, n: number, id: string): string {
  const lines = text.split("\n");
  const tag = core.findTag(lines[n])!;
  lines[n] = core.dispatchText(lines[n], tag, id);
  return lines.join("\n");
}

test("finds a tag and its request", () => {
  assert.deepEqual(core.findTag("@ai a table of planets"), { start: 0, request: "a table of planets" });
  assert.deepEqual(core.findTag("Moons are odd. @ai list the big ones  "), { start: 15, request: "list the big ones" });
  assert.deepEqual(core.findTag("- @ai graph this"), { start: 2, request: "graph this" });
});

test("ignores things that aren't tags", () => {
  assert.equal(core.findTag("mail me@ai.com later"), null);
  assert.equal(core.findTag("@ai"), null);
  assert.equal(core.findTag("@aim high"), null);
  assert.equal(core.findTag("%%@ai a table%%"), null); // already sent
});

test("supports a custom tag word", () => {
  assert.equal(core.findTag("@claude draw it", "@claude")?.request, "draw it");
  assert.equal(core.findTag("@ai draw it", "@claude"), null);
});

test("sending hides the tag and adds a thinking line", () => {
  const out = send("Notes\nMoons. @ai a table\nmore", 1, "abc123");
  assert.equal(out, 'Notes\nMoons. %%@ai a table%%\n%%ai:abc123%%<span class="inline-ai-thinking"><span>Thinking</span></span>\nmore');
  assert.equal(core.findTag(out.split("\n")[1]), null);
});

test("answer lands under the tag even after typing above and below", () => {
  let text = send("# Book notes\nChapter 1\n@ai a table of the characters\n", 2, "id1");
  // keep writing below, then add lines above
  text += "Chapter 2 starts in Paris.\nMore thoughts.";
  text = "Intro line\n\n" + text;
  const out = core.applyAnswer(text, "id1", "| Name | Role |\n|---|---|\n| Ana | Hero |")!;
  assert.equal(
    out,
    "Intro line\n\n# Book notes\nChapter 1\n%%@ai a table of the characters%%\n\n" +
      "| Name | Role |\n|---|---|\n| Ana | Hero |\n\nChapter 2 starts in Paris.\nMore thoughts.",
  );
});

test("several tags in flight resolve in any order", () => {
  let text = "A\n@ai first\nB\n@ai second\nC";
  text = send(text, 1, "one");
  text = send(text, 4, "two");
  text = core.applyAnswer(text, "two", "SECOND")!;
  text = core.applyAnswer(text, "one", "FIRST")!;
  const lines = text.split("\n");
  assert.equal(lines[lines.indexOf("%%@ai first%%") + 2], "FIRST");
  assert.equal(lines[lines.indexOf("%%@ai second%%") + 2], "SECOND");
  assert.ok(!text.includes("%%ai:"));
});

test("text typed on the thinking line is kept", () => {
  let text = send("x\n@ai hi\n", 1, "k");
  text = text.replace("</span></span>", "</span></span> oops typed here");
  const out = core.applyAnswer(text, "k", "Hello")!;
  assert.equal(out, "x\n%%@ai hi%%\n\nHello\n\noops typed here\n");
});

test("an answer whose thinking line was deleted is dropped", () => {
  const text = send("x\n@ai hi", 1, "gone").replace(/\n%%ai:gone.*$/, "");
  assert.equal(core.applyAnswer(text, "gone", "Hello"), null);
});

test("context is the whole note with the tag's spot marked", () => {
  const text = "# Myth\nPara one.\n%%@ai check this%%\n%%ai:k1%%<span class=\"inline-ai-thinking\"><span>Thinking</span></span>\nAfter.";
  const at = text.indexOf("%%ai:k1");
  assert.equal(core.buildContext(text, at), "# Myth\nPara one.\n%%@ai check this%%\n<<<AI_TAG_HERE>>>\nAfter.");
});

test("a placeholder from 0.1.0 is still replaced cleanly", () => {
  const out = core.applyAnswer("x\n%%@ai hi%%\n%%ai:old%% ⏳ *AI is thinking…*\n", "old", "Hello");
  assert.equal(out, "x\n%%@ai hi%%\n\nHello\n");
});

test("pulls out SVG blocks", () => {
  const md = "Here:\n```svg\n<svg xmlns='x' viewBox='0 0 1 1'><rect/></svg>\n```\nand\n```mermaid\ngraph TD; A-->B\n```";
  const { md: out, svgs } = core.extractSvgs(md);
  assert.deepEqual(svgs, ["<svg xmlns='x' viewBox='0 0 1 1'><rect/></svg>"]);
  assert.equal(out, "Here:\n{{svg:0}}\nand\n```mermaid\ngraph TD; A-->B\n```");
});

const settings = { apiKey: "test-key", model: "claude-opus-5-5", effort: "medium", maxTokens: 16000, refusalFallback: true, webSearch: true, allowEdits: false };

test("builds the API request", () => {
  const { url, headers, body } = core.buildRequest(settings, "a table", "ctx", "The Cry for Myth");
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(headers["anthropic-version"], "2026-10-21");
  assert.equal(headers["x-api-key"], "test-key");
  assert.equal(headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.equal(body.fallbacks, "default");
  assert.deepEqual(body.output_config, { effort: "medium" });
  assert.equal(body.model, "claude-opus-5-5");
  assert.ok(!("temperature" in body) && !("thinking" in body));
  assert.deepEqual(body.tools, [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }]);
  assert.doesNotMatch(body.system as string, /edit_note/);
  assert.match((body.messages as any)[0].content, /^<note title="The Cry for Myth">\nctx\n<\/note>\n\nRequest: a table$/);
});

test("web search can be off, and older models get the basic search tool", () => {
  assert.equal(core.buildRequest({ ...settings, webSearch: false }, "x", "y").body.tools, undefined);
  const haiku = core.buildRequest({ ...settings, model: "claude-haiku-5-5" }, "x", "y").body.tools as any[];
  assert.equal(haiku[0].type, "web_search_20250305");
});

test("short source links after cited facts, at most three", () => {
  const cite = (url: string) => ({ type: "web_search_result_location", url, cited_text: "..." });
  const blocks = [
    { type: "server_tool_use", name: "web_search" },
    { type: "web_search_tool_result", content: [] },
    { type: "text", text: "About 81% say yes", citations: [cite("https://news.gallup.com/poll/1")] },
    { type: "text", text: ", and 29% have no religion", citations: [cite("https://www.pewresearch.org/a (b)")] },
    { type: "text", text: "." },
  ];
  assert.equal(
    core.answerFrom(blocks, "end_turn", true),
    "About 81% say yes ([news.gallup.com](https://news.gallup.com/poll/1)), and 29% have no religion ([pewresearch.org](https://www.pewresearch.org/a%20(b%29))."
  );
  assert.equal(core.answerFrom(blocks, "end_turn", false), "About 81% say yes, and 29% have no religion.");
});

test("a paused search turn resumes with everything so far", () => {
  const { body } = core.buildRequest(settings, "x", "y");
  const next = core.resumeBody(body, [{ type: "server_tool_use" }]);
  assert.equal(next.messages.length, 2);
  assert.deepEqual(next.messages[1], { role: "assistant", content: [{ type: "server_tool_use" }] });
  assert.equal(next.model, body.model);
});

test("leaves the fallback off for models without it", () => {
  const { headers, body } = core.buildRequest({ ...settings, model: "claude-haiku-5-5" }, "x", "y");
  assert.equal(headers["anthropic-beta"], undefined);
  assert.equal(body.fallbacks, undefined);
});

test("reads answers and errors", () => {
  const ok = { content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Hi " }, { type: "text", text: "there" }], stop_reason: "end_turn" };
  assert.equal(core.parseResponse(200, ok), "Hi there");
  assert.equal(core.parseResponse(200, { content: [{ type: "text", text: "```markdown\n| a |\n```" }] }), "| a |");
  assert.match(core.parseResponse(200, { content: [{ type: "text", text: "long" }], stop_reason: "max_tokens" }), /cut off/);
  assert.throws(() => core.parseResponse(401, { type: "error", error: { message: "invalid x-api-key" } }), /didn't accept the API key/);
  assert.throws(() => core.parseResponse(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), /overloaded/);
  assert.throws(() => core.parseResponse(400, { type: "error", error: { message: "max_tokens: too big" } }), /max_tokens: too big/);
  assert.throws(() => core.parseResponse(502, null), /HTTP 502/);
  assert.throws(() => core.parseResponse(200, { content: [], stop_reason: "refusal" }), /declined/);
});

test("finds the markers to hide while editing", () => {
  const line = "Some text %%@ai is this right?%% more";
  const r = core.markerRanges(line);
  assert.deepEqual(r.hide, [[10, 12], [30, 32]]);
  assert.equal(line.slice(...r.tag[0]), "@ai is this right?");
  assert.deepEqual(r.pill, []);

  const pillLine = '%%ai:c54keh%%<span class="inline-ai-thinking"><span>Thinking</span></span>';
  assert.deepEqual(core.markerRanges(pillLine).pill, [[0, pillLine.length]]);
  const oldPill = "%%ai:c54keh%% ⏳ *AI is thinking…*";
  assert.deepEqual(core.markerRanges(oldPill).pill, [[0, oldPill.length]]);
  assert.deepEqual(core.markerRanges("%% my own comment %%"), { hide: [], tag: [], pill: [] });
  assert.equal(core.markerRanges("%%@claude hi%%", "@claude").tag.length, 1);
});

// ---- 0.3.0: edits and streaming

const noteWithTag = (id: string) =>
  "# Moons\nEuropa has 79 moons around it.\nIo is volcanic.\n%%@ai fix the moon count%%\n%%ai:" + id +
  '%%<span class="inline-ai-thinking"><span>Thinking</span></span>\nMore notes.';

test("the edit tool is offered when edits are on", () => {
  const { body } = core.buildRequest({ ...settings, allowEdits: true }, "x", "y");
  const tools = body.tools as any[];
  assert.equal(tools[1].name, "edit_note");
  assert.match(body.system as string, /edit_note/);
  assert.equal((core.buildRequest({ ...settings, allowEdits: true, webSearch: false }, "x", "y").body.tools as any[]).length, 1);
});

test("reads an edit_note call, ignoring any text around it", () => {
  const blocks = [
    { type: "text", text: "I'll fix that." },
    { type: "tool_use", name: "edit_note", input: { edits: [{ find: "79 moons", replace: "about 95 moons" }], note: " Fixed the count. " } },
  ];
  assert.deepEqual(core.resultFrom(blocks, "tool_use"), { answer: "Fixed the count.", edits: [{ find: "79 moons", replace: "about 95 moons" }] });
  assert.deepEqual(core.resultFrom([{ type: "text", text: "Hi" }], "end_turn"), { answer: "Hi", edits: null });
  assert.throws(() => core.resultFrom([{ type: "tool_use", name: "edit_note", input: null }], "max_tokens"), /cut off/);
  assert.throws(() => core.resultFrom([{ type: "tool_use", name: "edit_note", input: { edits: [{ find: 1 }] } }], "tool_use"), /incomplete/);
});

test("an edit changes text above the tag and the note lands at the tag", () => {
  const text = noteWithTag("e1");
  const plan = core.planChanges(text, "e1", { answer: "Fixed the count.", edits: [{ find: "has 79 moons around it", replace: "is a moon of Jupiter" }] })!;
  assert.equal(plan.edited, 1);
  assert.equal(
    core.applyChanges(text, plan.changes),
    "# Moons\nEuropa is a moon of Jupiter.\nIo is volcanic.\n%%@ai fix the moon count%%\n\nFixed the count.\n\nMore notes.",
  );
});

test("an edit with no note removes the thinking line", () => {
  const text = noteWithTag("e2");
  const plan = core.planChanges(text, "e2", { answer: "", edits: [{ find: "Io is volcanic.", replace: "Io is the most volcanic body known." }] })!;
  assert.equal(
    core.applyChanges(text, plan.changes),
    "# Moons\nEuropa has 79 moons around it.\nIo is the most volcanic body known.\n%%@ai fix the moon count%%\nMore notes.",
  );
  // last line of the note
  const last = "Alpha\n%%@ai x%%\n%%ai:z%%<span class=\"inline-ai-thinking\"><span>Thinking</span></span>";
  assert.equal(core.applyChanges(last, core.planChanges(last, "z", { answer: "", edits: [{ find: "Alpha", replace: "Beta" }] })!.changes), "Beta\n%%@ai x%%");
});

test("several edits apply together, in any order", () => {
  const text = noteWithTag("e3");
  const plan = core.planChanges(text, "e3", {
    answer: "",
    edits: [
      { find: "More notes.", replace: "More notes!" },
      { find: "# Moons", replace: "# Moons of the solar system" },
    ],
  })!;
  const out = core.applyChanges(text, plan.changes);
  assert.ok(out.startsWith("# Moons of the solar system\n") && out.endsWith("\nMore notes!"));
  assert.equal(plan.edited, 2);
});

test("edits that can't be placed safely change nothing and leave a warning", () => {
  const text = noteWithTag("e4");
  const check = (edits: core.Edit[], reason: RegExp) => {
    const plan = core.planChanges(text, "e4", { answer: "note", edits })!;
    assert.equal(plan.edited, 0);
    assert.equal(plan.changes.length, 1);
    const out = core.applyChanges(text, plan.changes);
    assert.match(out, reason);
    assert.match(out, /\[!warning\] Inline AI couldn't make the edit/);
    assert.ok(out.includes("Europa has 79 moons around it.\nIo is volcanic."), "note text untouched");
  };
  check([{ find: "Ganymede", replace: "x" }], /isn't in the note/);
  check([{ find: "o", replace: "0" }], /more than once/);
  check([{ find: "fix the moon count", replace: "x" }], /request itself/);
  check([{ find: "volcanic.\n%%@ai", replace: "x" }], /request itself/);
  check([{ find: "<<<AI_TAG_HERE>>>", replace: "x" }], /request itself/);
  check([{ find: "has 79", replace: "a" }, { find: "79 moons", replace: "b" }], /overlapped/);
  check([{ find: "", replace: "x" }], /didn't say/);
});

test("an edit for a deleted thinking line is dropped", () => {
  assert.equal(core.planChanges("a\nb", "nope", { answer: "", edits: [{ find: "a", replace: "c" }] }), null);
});

// Splits a list of events into SSE text, then feeds it in awkward chunks.
function sse(events: object[], chunk = 7): string[] {
  const all = events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const out: string[] = [];
  for (let i = 0; i < all.length; i += chunk) out.push(all.slice(i, i + chunk));
  return out;
}

test("rebuilds a streamed reply with search, citations and an edit", () => {
  const statuses: string[] = [];
  const p = new core.StreamParser((s) => statuses.push(s));
  const events = [
    { type: "message_start", message: { content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "s1", name: "web_search", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"jupiter moons"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "u" }] } },
    { type: "content_block_stop", index: 2 },
    { type: "ping" },
    { type: "content_block_start", index: 3, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 3, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://nasa.gov/j" } } },
    { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "Jupiter has 95 " } },
    { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "moons." } },
    { type: "content_block_stop", index: 3 },
    { type: "content_block_start", index: 4, content_block: { type: "tool_use", id: "t1", name: "edit_note", input: {} } },
    { type: "content_block_delta", index: 4, delta: { type: "input_json_delta", partial_json: '{"edits":[{"find":"79","rep' } },
    { type: "content_block_delta", index: 4, delta: { type: "input_json_delta", partial_json: 'lace":"95"}]}' } },
    { type: "content_block_stop", index: 4 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ];
  for (const c of sse(events)) p.push(c);
  const blocks = p.finish();
  assert.equal(p.stopReason, "tool_use");
  assert.deepEqual(blocks[0], { type: "thinking", thinking: "hmm", signature: "sig" });
  assert.deepEqual(blocks[1].input, { query: "jupiter moons" });
  assert.equal(blocks[2].content[0].url, "u");
  assert.equal(blocks[3].text, "Jupiter has 95 moons.");
  assert.equal(blocks[3].citations[0].url, "https://nasa.gov/j");
  assert.deepEqual(core.resultFrom(blocks, p.stopReason!).edits, [{ find: "79", replace: "95" }]);
  assert.deepEqual(statuses, ["Thinking", "Searching the web", "Reading", "Writing", "Editing"]);
});

test("a stream cut off mid-edit or ending in an error is reported", () => {
  const p = new core.StreamParser();
  for (const c of sse([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "edit_note", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"edits":[{"fi' } },
    { type: "message_delta", delta: { stop_reason: "max_tokens" } },
  ])) p.push(c);
  assert.throws(() => core.resultFrom(p.finish(), p.stopReason!), /cut off/);

  const q = new core.StreamParser();
  assert.throws(() => sse([{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }], 1000).forEach((c) => q.push(c)), /overloaded/);
});

test("a paused streamed turn resumes with its blocks as they arrived", () => {
  const p = new core.StreamParser();
  for (const c of sse([
    { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "s1", name: "web_search", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"x"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "pause_turn" } },
  ])) p.push(c);
  const { body } = core.buildRequest(settings, "x", "y");
  const next = core.resumeBody(body, p.finish());
  assert.deepEqual(next.messages[1].content, [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "x" } }]);
});
