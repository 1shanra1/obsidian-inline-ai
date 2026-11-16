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

// Finishes a tag the way the plugin does, and checks the two-step delivery
// lands on the same text as applying the plan in one go.
function finish(text: string, id: string, result: core.Result): string {
  const plan = core.planChanges(text, id, result)!;
  const out = core.finalText(text, plan);
  if (plan.changes.length) assert.equal(core.applyChanges(text, plan.changes), out, "restore + mapped changes == direct changes");
  return out;
}
const answer = (text: string, id: string, a: string) => finish(text, id, { answer: a, edits: null });

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

test("the answer takes the tag's place, even after typing above and below", () => {
  let text = send("# Book notes\nChapter 1\n@ai a table of the characters\n", 2, "id1");
  text += "Chapter 2 starts in Paris.\nMore thoughts.";
  text = "Intro line\n\n" + text;
  assert.equal(
    answer(text, "id1", "| Name | Role |\n|---|---|\n| Ana | Hero |"),
    "Intro line\n\n# Book notes\nChapter 1\n\n| Name | Role |\n|---|---|\n| Ana | Hero |\n\nChapter 2 starts in Paris.\nMore thoughts.",
  );
});

test("text before the tag on its line stays", () => {
  const text = send("Notes\nMoons are odd. @ai a list\nmore", 1, "t1");
  assert.equal(answer(text, "t1", "- Io"), "Notes\nMoons are odd.\n\n- Io\n\nmore");
});

test("several tags in flight resolve in any order", () => {
  let text = "A\n@ai first\nB\n@ai second\nC";
  text = send(text, 1, "one");
  text = send(text, 4, "two");
  text = answer(text, "two", "SECOND");
  text = answer(text, "one", "FIRST");
  assert.equal(text, "A\n\nFIRST\n\nB\n\nSECOND\n\nC");
});

test("text typed on the thinking line is kept", () => {
  let text = send("x\n@ai hi\n", 1, "k");
  text = text.replace("</span></span>", "</span></span> oops typed here");
  assert.equal(answer(text, "k", "Hello"), "x\n\nHello\n\noops typed here\n");
});

test("a failed tag comes back as the plain text you typed", () => {
  const text = send("Notes\nMoons are odd. @ai a list\nmore", 1, "f1");
  const plan = core.planChanges(text, "f1", { answer: "", edits: null, error: "couldn't answer: overloaded" })!;
  assert.equal(plan.failure, "couldn't answer: overloaded");
  assert.deepEqual(plan.changes, []);
  assert.equal(core.finalText(text, plan), "Notes\nMoons are odd. @ai a list\nmore");
  assert.ok(core.findTag(core.finalText(text, plan).split("\n")[1]), "it can be sent again");
});

test("an answer whose thinking line was deleted is dropped", () => {
  const text = send("x\n@ai hi", 1, "gone").replace(/\n%%ai:gone.*$/, "");
  assert.equal(core.planChanges(text, "gone", { answer: "Hello", edits: null }), null);
});

test("context is the whole note with the tag's spot marked and other tags left out", () => {
  let text = send(send("# Myth\nPara one. @ai check this\nAfter.\n@ai other", 1, "k1"), 4, "k2");
  assert.equal(core.buildContext(text, "k1"), "# Myth\nPara one. <<<AI_TAG_HERE>>>\nAfter.\n");
});

test("a placeholder from 0.1.0 is still replaced cleanly", () => {
  assert.equal(answer("x\n%%@ai hi%%\n%%ai:old%% ⏳ *AI is thinking…*\n", "old", "Hello"), "x\n\nHello\n");
});

test("pulls out SVG blocks", () => {
  const md = "Here:\n```svg\n<svg xmlns='x' viewBox='0 0 1 1'><rect/></svg>\n```\nand\n```mermaid\ngraph TD; A-->B\n```";
  const { md: out, svgs } = core.extractSvgs(md);
  assert.deepEqual(svgs, ["<svg xmlns='x' viewBox='0 0 1 1'><rect/></svg>"]);
  assert.equal(out, "Here:\n{{svg:0}}\nand\n```mermaid\ngraph TD; A-->B\n```");
});

const settings = { apiKey: "test-key", model: "claude-opus-5-5", effort: "medium", maxTokens: 16000, refusalFallback: true, webSearch: true, allowEdits: false, maxSearches: 0 };

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
  assert.deepEqual(body.tools, [{ type: "web_search_20260209", name: "web_search" }]);
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
  send("# Moons\n\nEuropa has 79 moons around it.\n\nIo is volcanic.\n\n@ai fix the moon count\nMore notes.", 6, id);

test("the edit tool is offered when edits are on", () => {
  const { body } = core.buildRequest({ ...settings, allowEdits: true }, "x", "y");
  assert.equal((body.tools as any[])[1].name, "edit_note");
  assert.match(body.system as string, /edit_note/);
  assert.equal((core.buildRequest({ ...settings, allowEdits: true, webSearch: false }, "x", "y").body.tools as any[]).length, 1);
});

test("reads an edit_note call, with its note for the pop-up", () => {
  const blocks = [
    { type: "text", text: "I'll fix that." },
    { type: "tool_use", name: "edit_note", input: { edits: [{ find: "79 moons", replace: "about 95 moons" }], note: " Fixed the count. " } },
  ];
  assert.deepEqual(core.resultFrom(blocks, "tool_use"), { answer: "", edits: [{ find: "79 moons", replace: "about 95 moons" }], note: "Fixed the count.", searchErrors: undefined });
  assert.deepEqual(core.resultFrom([{ type: "text", text: "Hi" }], "end_turn"), { answer: "Hi", edits: null, searchErrors: undefined });
  assert.throws(() => core.resultFrom([{ type: "tool_use", name: "edit_note", input: null }], "max_tokens"), /cut off/);
  assert.throws(() => core.resultFrom([{ type: "tool_use", name: "edit_note", input: { edits: [{ find: 1 }] } }], "tool_use"), /incomplete/);
});

test("notices when a web search failed", () => {
  const blocks = [{ type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "too_many_requests" } }, { type: "text", text: "From memory." }];
  assert.deepEqual(core.resultFrom(blocks, "end_turn").searchErrors, ["too_many_requests"]);
});

test("finds search errors nested inside code-filtered results", () => {
  const blocks = [
    { type: "server_tool_use", name: "code_execution", input: { code: "search()" } },
    { type: "code_execution_tool_result", content: { type: "code_execution_result", stdout: "", content: [{ type: "web_search_tool_result_error", error_code: "max_uses_exceeded" }] } },
    { type: "text", text: "My search stopped working." },
  ];
  assert.deepEqual(core.resultFrom(blocks, "end_turn").searchErrors, ["max_uses_exceeded"]);
  assert.match(core.searchErrorText("max_uses_exceeded"), /limit/);
  assert.equal(core.searchErrorText("some_new_code"), "some new code");
  assert.deepEqual(core.describeBlocks(blocks), ["server_tool_use code_execution (code)", "code_execution_tool_result: error max_uses_exceeded", "text (26 chars)"]);
});

test("no search limit unless one is set", () => {
  const capped = core.buildRequest({ ...settings, maxSearches: 5 }, "x", "y").body.tools as any[];
  assert.equal(capped[0].max_uses, 5);
  const free = core.buildRequest(settings, "x", "y").body.tools as any[];
  assert.ok(!("max_uses" in free[0]));
});

test("the stream parser keeps the search count", () => {
  const p = new core.StreamParser(() => {});
  p.push('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n');
  p.push('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9,"server_tool_use":{"web_search_requests":4}}}\n\n');
  p.finish();
  assert.equal(p.usage.server_tool_use.web_search_requests, 4);
  assert.equal(p.usage.input_tokens, 5);
});

test("an edit changes text above, and the tag leaves no trace", () => {
  const text = noteWithTag("e1");
  const plan = core.planChanges(text, "e1", { answer: "", note: "Fixed it", edits: [{ find: "has 79 moons around it", replace: "is a moon of Jupiter" }] })!;
  assert.equal(plan.edited, 1);
  assert.equal(finish(text, "e1", { answer: "", edits: [{ find: "has 79 moons around it", replace: "is a moon of Jupiter" }] }),
    "# Moons\n\nEuropa is a moon of Jupiter.\n\nIo is volcanic.\n\nMore notes.");
});

test("removing sections leaves no blank gaps", () => {
  const text = "# Data\n\nIntro.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n\n| c | d |\n|---|---|\n| 3 | 4 |\n\nOutro.";
  const out = core.applyChanges(text, core.tidyGaps(text, [
    { from: text.indexOf("| a"), to: text.indexOf("| 2 |") + 5, insert: "" },
    { from: text.indexOf("| c"), to: text.indexOf("| 4 |") + 5, insert: "- 2026: 5" },
  ]));
  assert.equal(out, "# Data\n\nIntro.\n\n- 2026: 5\n\nOutro.");
  // a list item goes without adding a blank line
  const list = "- a\n- b\n- c";
  assert.equal(core.applyChanges(list, core.tidyGaps(list, [{ from: 4, to: 7, insert: "" }])), "- a\n- c");
  // inside a line, nothing extra is touched
  const line = "the big cat";
  assert.equal(core.applyChanges(line, core.tidyGaps(line, [{ from: 4, to: 7, insert: "" }])), "the  cat");
  // at the very start and end
  const ends = "TOP\n\nmiddle\n\nEND\n";
  assert.equal(core.applyChanges(ends, core.tidyGaps(ends, [{ from: 0, to: 3, insert: "" }, { from: 13, to: 16, insert: "" }])), "middle\n");
});

test("an edit can remove old request lines from earlier versions", () => {
  let text = "Facts.\n\n%%@ai old ask%%\n\n| t |\n\n@ai remove the table\nNext.";
  text = send(text, 6, "r1");
  const out = finish(text, "r1", { answer: "", edits: [{ find: "%%@ai old ask%%", replace: "" }, { find: "| t |", replace: "" }] });
  assert.equal(out, "Facts.\n\nNext.");
});

test("several edits apply together, in any order", () => {
  const text = noteWithTag("e3");
  const out = finish(text, "e3", { answer: "", edits: [{ find: "More notes.", replace: "More notes!" }, { find: "# Moons", replace: "# Moons of the solar system" }] });
  assert.ok(out.startsWith("# Moons of the solar system\n") && out.endsWith("\nMore notes!"));
});

test("edits that can't be placed safely change nothing and bring the tag back", () => {
  let text = noteWithTag("e4");
  text = send(text + "\n@ai another", text.split("\n").length, "busy");
  const check = (edits: core.Edit[], reason: RegExp) => {
    const plan = core.planChanges(text, "e4", { answer: "", edits })!;
    assert.equal(plan.edited, 0);
    assert.deepEqual(plan.changes, []);
    assert.match(plan.failure!, reason);
    const out = core.finalText(text, plan);
    assert.ok(out.includes("Europa has 79 moons around it.\n\nIo is volcanic.\n\n@ai fix the moon count\nMore notes."), out);
  };
  check([{ find: "Ganymede", replace: "x" }], /isn't in the note/);
  check([{ find: "o", replace: "0" }], /more than once/);
  check([{ find: "<<<AI_TAG_HERE>>>", replace: "x" }], /request itself/);
  check([{ find: "@ai another", replace: "x" }], /still waiting/);
  check([{ find: "has 79", replace: "a" }, { find: "79 moons", replace: "b" }], /overlapped/);
  check([{ find: "", replace: "x" }], /didn't say/);
});

test("clean-up brings interrupted tags back and removes old request lines", () => {
  let text = "A\n\n%%@ai stale%%\n\nB\nSome text %%@ai inline stale%%\n@ai waiting\n@ai live\nC";
  text = send(send(text, 6, "dead"), 8, "alive");
  const out = core.applyChanges(text, core.cleanupChanges(text, "@ai", (id) => id === "alive"));
  assert.equal(out, 'A\n\nB\nSome text\n@ai waiting\n%%@ai live%%\n%%ai:alive%%<span class="inline-ai-thinking"><span>Thinking</span></span>\nC');
});

test("mapping changes through the restore step", () => {
  const r = { from: 5, to: 10, insert: "ab" };
  assert.deepEqual(core.mapThrough([{ from: 0, to: 2, insert: "x" }, { from: 5, to: 10, insert: "y" }, { from: 12, to: 14, insert: "z" }], r), [
    { from: 0, to: 2, insert: "x" },
    { from: 5, to: 7, insert: "y" },
    { from: 9, to: 11, insert: "z" },
  ]);
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

// ---- 0.4.0: answer cards

test("short answers stay plain text", () => {
  assert.equal(core.formatAnswer("About 95 moons (2023 count).", "how many moons?"), "About 95 moons (2023 count).");
  assert.equal(core.formatAnswer("Yes, that holds up.\n\nThe figure is from 2022.", "is this right?"), "Yes, that holds up.\n\nThe figure is from 2022.");
});

test("a titled answer becomes a foldable card", () => {
  const out = core.formatAnswer("Title: **Myth as shared meaning.**\nMay says myths give a group a shared story.\n\n**Example:** the frontier myth.", "explain this");
  assert.equal(out, "> [!ai]+ Myth as shared meaning\n> May says myths give a group a shared story.\n>\n> **Example:** the frontier myth.");
});

test("a long untitled answer gets a card titled by the request", () => {
  const body = "| Year | Rate |\n|---|---|\n| 2023 | 5% |";
  assert.equal(core.formatAnswer(body, "get me the newest numbers?"), "> [!ai]+ Get me the newest numbers\n> | Year | Rate |\n> |---|---|\n> | 2023 | 5% |");
  const long = core.formatAnswer("word ".repeat(120), "x".repeat(80));
  assert.match(long, /^> \[!ai\]\+ Xx+…\n> word/);
});

test("with cards off, answers stay plain and lose the title line", () => {
  assert.equal(core.formatAnswer("Title: Myth\nBody text.", "q", false), "Body text.");
});

test("a card lands in the note in place of the tag", () => {
  const text = send("Para.\n@ai explain this\nNext.", 1, "c1");
  assert.equal(answer(text, "c1", core.formatAnswer("Title: Idea\nOne.\n\nTwo.", "explain this")), "Para.\n\n> [!ai]+ Idea\n> One.\n>\n> Two.\n\nNext.");
});

test("the prompt asks for length to fit the request and a title for longer replies", () => {
  const p = core.systemPrompt(false);
  assert.match(p, /reading companion/);
  assert.match(p, /Fit the length to the request/);
  assert.match(p, /"Title: "/);
});
