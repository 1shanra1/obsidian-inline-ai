# Inline AI for Obsidian

Type `@ai` and a request anywhere in a note, press Enter, and keep writing. Claude's answer appears right under the tag when it's ready. Works on iPad and desktop.

```
Moons of the outer planets are wild.
@ai a table of the five biggest moons with their planet and diameter
I should look into Europa's ocean next...
```

You can have several tags waiting at once. Ask for text, a table, a Mermaid diagram or chart, or an image (saved as an SVG file in your attachments folder).

## How it works

1. When you finish a line with a tag, the plugin hides the tag in a comment (`%%@ai ...%%`) and adds a "thinking" line under it with a hidden id.
2. It sends your request and the text around it to the Anthropic API, using Obsidian's own `requestUrl`, so it runs on iPad.
3. When the answer comes back, it finds the thinking line by its id and replaces it. It edits through the editor, so your typing isn't disturbed, and the answer still lands in the right place if you added lines above or below.

The code is three files: `src/core.ts` (tag and insert logic, tested), `src/main.ts` (Obsidian glue), `src/settings.ts`.

## Install

The plugin is two files: `main.js` and `manifest.json`. They go in `<your vault>/.obsidian/plugins/inline-ai/`.

- **Vault in iCloud, with a Mac:** copy the two files into that folder on your Mac. iCloud syncs them to your iPad.
- **Obsidian Sync:** copy them in on any computer, and turn on "Installed community plugins" in Sync settings on both devices.

Then in Obsidian: Settings → Community plugins → turn on Inline AI, open its settings, and paste your Anthropic API key.

## Settings

- **Anthropic API key:** stored in the plugin's `data.json` in your vault, so it syncs with your vault. Don't commit that file anywhere.
- **Model:** default `claude-opus-5-5`.
- **Effort:** default `medium`. Lower is faster.
- **Tag word:** default `@ai`.
- **Send on Enter:** on by default. The command "Inline AI: Send the tag on this line" always works too.
- **Note context:** how many characters around the tag are sent (default 6000).
- **Max answer tokens:** default 16000.
- **Retry declined requests on another model:** on by default.

## Develop

```
npm install
npm test        # tag and insert logic
npm run build   # type-checks and writes main.js
```
