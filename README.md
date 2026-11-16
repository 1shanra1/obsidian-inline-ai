# Inline AI for Obsidian

Type `@ai` and a request anywhere in a note, press Enter, and keep writing. Claude's answer appears right under the tag when it's ready. Works on iPad and desktop.

```
Moons of the outer planets are wild.
@ai a table of the five biggest moons with their planet and diameter
I should look into Europa's ocean next...
```

You can have several tags waiting at once. Ask for text, a table, a Mermaid diagram or chart, or an image (saved as an SVG file in your attachments folder).

## How it works

1. When you finish a line with a tag, the plugin hides the tag in a comment (`%%@ai ...%%`) and puts an animated "Thinking" pill under it, tagged with a hidden id.
2. It sends your request and the whole note, with the tag's spot marked, to the Anthropic API using Obsidian's own `requestUrl`, so it runs on iPad. Claude answers about the text around the tag, keeps it short, and searches the web when it needs facts.
3. When the answer comes back, it finds the pill by its id and replaces it. It edits through the editor, so your typing isn't disturbed, and the answer still lands in the right place if you added lines above or below.

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
