# Inline AI for Obsidian

Type `@ai` and a request anywhere in a note, press Enter, and keep writing. When Claude's answer is ready, it takes the tag's place. Works on iPad and desktop.

```
Moons of the outer planets are wild.
@ai a table of the five biggest moons with their planet and diameter
I should look into Europa's ocean next...
```

You can have several tags waiting at once. Ask for text, a table, a Mermaid diagram or chart, or an image (saved as an SVG file in your attachments folder).

Claude can also change what's already there. Write `@ai fix the dates in the paragraph above` or `@ai update these numbers to 2026`, and it edits that text in place, tidies up any blank lines left behind, and tells you what it changed in a pop-up. If the text changed while Claude was working, it changes nothing.

A tag is temporary: once it's answered, it's gone, and the note keeps only your writing and Claude's answers. One undo turns an answer or an edit back into the `@ai ...` text you typed. If something goes wrong, a pop-up says what, and your tag comes back as text, so you can press Enter at its end to send it again.

## How it works

1. When you finish a line with a tag, the plugin hides the tag in a comment (`%%@ai ...%%`) and puts an animated "Thinking" pill under it, tagged with a hidden id. If Obsidian closes while a tag is waiting, its pill says "Interrupted"; the command "Inline AI: Clean up old tags in this note" turns it back into text, and also removes request lines left by versions before 0.3.1.
2. It sends your request and the whole note, with the tag's spot marked, to the Anthropic API and streams the reply, so a long web search can't time out. The pill shows what Claude is doing: thinking, searching the web, writing or editing. Claude answers about the text around the tag, keeps it short, and searches the web when it needs facts. If streaming isn't possible, it falls back to one ordinary request.
3. When the answer comes back, it finds the pill by its id and replaces the tag and the pill with it. If Claude asked to edit the note, each edit must match exactly one passage, and all of them go in as a single change. It edits through the editor, so your typing isn't disturbed, and the answer still lands in the right place if you added lines above or below.

While you edit, the `%%` markers stay hidden: a sent tag shows as a quiet chip and a waiting answer as the pill. Put the cursor on the line to see the raw text.

The code is four files: `src/core.ts` (tag and insert logic, tested), `src/main.ts` (Obsidian glue), `src/editor.ts` (hides the markers while editing), `src/settings.ts`.

## Install

**On iPad, with no computer (BRAT):**

1. In Obsidian, go to Settings → Community plugins → Browse, and install and enable **BRAT**.
2. Open BRAT's settings, tap **Add Beta plugin**, and enter `1shanra1/obsidian-inline-ai`.
3. Turn on **Inline AI** under Community plugins.

BRAT installs the latest GitHub release and can update it later.

**By copying files:** the plugin is three files, `main.js`, `manifest.json` and `styles.css`. They go in `<your vault>/.obsidian/plugins/inline-ai/`.

- **Vault in iCloud, with a Mac:** copy the three files into that folder on your Mac. iCloud syncs them to your iPad.
- **Obsidian Sync:** copy them in on any computer, and turn on "Installed community plugins" in Sync settings on both devices.

Then turn on Inline AI under Community plugins.

Either way, open Inline AI's settings and paste your Anthropic API key.

## Settings

- **Anthropic API key:** stored in the plugin's `data.json` in your vault, so it syncs with your vault. Don't commit that file anywhere.
- **Model:** default `claude-opus-5-5`.
- **Effort:** default `medium`. Lower is faster.
- **Tag word:** default `@ai`.
- **Send on Enter:** on by default. The command "Inline AI: Send the tag on this line" always works too.
- **Let Claude edit the note:** on by default. Turn it off and Claude only ever adds text at the tag.
- **Web search:** on by default. Claude searches only when a request needs facts or anything recent.
- **Source links:** on by default. Adds a short link after facts found on the web, three at most.
- **Max answer tokens:** default 16000.
- **Retry declined requests on another model:** on by default.

## Develop

```
npm install
npm test        # tag and insert logic
npm run build   # type-checks and writes main.js
```
