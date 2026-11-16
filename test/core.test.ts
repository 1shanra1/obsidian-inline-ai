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
  assert.equal(out, "Notes\nMoons. %%@ai a table%%\n%%ai:abc123%% ⏳ *AI is thinking…*\nmore");
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
  text = text.replace("*AI is thinking…*", "*AI is thinking…* oops typed here");
  const out = core.applyAnswer(text, "k", "Hello")!;
  assert.equal(out, "x\n%%@ai hi%%\n\nHello\n\noops typed here\n");
});

test("an answer whose thinking line was deleted is dropped", () => {
  const text = send("x\n@ai hi", 1, "gone").replace(/\n%%ai:gone.*$/, "");
  assert.equal(core.applyAnswer(text, "gone", "Hello"), null);
});

test("context marks the tag spot and is trimmed", () => {
  const text = "a".repeat(100) + "b".repeat(100);
  const ctx = core.buildContext(text, 100, 40);
  assert.equal(ctx, "…" + "a".repeat(30) + "<<<AI_TAG_HERE>>>" + "b".repeat(10) + "…");
  assert.equal(core.buildContext("short", 5, 6000), "short<<<AI_TAG_HERE>>>");
});

test("pulls out SVG blocks", () => {
  const md = "Here:\n```svg\n<svg xmlns='x' viewBox='0 0 1 1'><rect/></svg>\n```\nand\n```mermaid\ngraph TD; A-->B\n```";
  const { md: out, svgs } = core.extractSvgs(md);
  assert.deepEqual(svgs, ["<svg xmlns='x' viewBox='0 0 1 1'><rect/></svg>"]);
  assert.equal(out, "Here:\n{{svg:0}}\nand\n```mermaid\ngraph TD; A-->B\n```");
});

const settings = { apiKey: "test-key", model: "claude-opus-5-5", effort: "medium", maxTokens: 16000, refusalFallback: true };

test("builds the API request", () => {
  const { url, headers, body } = core.buildRequest(settings, "a table", "ctx");
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(headers["anthropic-version"], "2026-10-21");
  assert.equal(headers["x-api-key"], "test-key");
  assert.equal(headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.equal(body.fallbacks, "default");
  assert.deepEqual(body.output_config, { effort: "medium" });
  assert.equal(body.model, "claude-opus-5-5");
  assert.ok(!("temperature" in body) && !("thinking" in body));
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
  assert.throws(() => core.parseResponse(401, { type: "error", error: { message: "invalid x-api-key" } }), /invalid x-api-key/);
  assert.throws(() => core.parseResponse(502, null), /HTTP 502/);
  assert.throws(() => core.parseResponse(200, { content: [], stop_reason: "refusal" }), /declined/);
});
