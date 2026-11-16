import { App, PluginSettingTab, Setting } from "obsidian";
import type InlineAIPlugin from "./main";

export interface InlineAISettings {
  apiKey: string;
  model: string;
  effort: string;
  tagWord: string;
  autoTrigger: boolean;
  maxTokens: number;
  refusalFallback: boolean;
  webSearch: boolean;
  showSources: boolean;
  allowEdits: boolean;
  cards: boolean;
  maxSearches: number;
  debugLog: boolean;
}

export const DEFAULT_SETTINGS: InlineAISettings = {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "medium",
  tagWord: "@ai",
  autoTrigger: true,
  maxTokens: 16000,
  refusalFallback: true,
  webSearch: true,
  showSources: true,
  allowEdits: true,
  cards: true,
  maxSearches: 0,
  debugLog: false,
};

export class InlineAISettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: InlineAIPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();

    new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc("Stored in this plugin's data.json inside your vault, so it syncs with your vault.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-ant-...").setValue(s.apiKey).onChange(async (v) => { s.apiKey = v.trim(); await save(); });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Any Claude model id, e.g. claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5.")
      .addText((t) => t.setValue(s.model).onChange(async (v) => { s.model = v.trim(); await save(); }));

    new Setting(containerEl)
      .setName("Effort")
      .setDesc("Lower is faster and cheaper; higher thinks harder.")
      .addDropdown((d) => {
        for (const e of ["low", "medium", "high", "xhigh", "max"]) d.addOption(e, e);
        d.setValue(s.effort).onChange(async (v) => { s.effort = v; await save(); });
      });

    new Setting(containerEl)
      .setName("Tag word")
      .setDesc("What you type before a request.")
      .addText((t) => t.setValue(s.tagWord).onChange(async (v) => { s.tagWord = v.trim() || "@ai"; await save(); }));

    new Setting(containerEl)
      .setName("Send on Enter")
      .setDesc("Send a tag when you finish its line. Off means only the command sends it.")
      .addToggle((t) => t.setValue(s.autoTrigger).onChange(async (v) => { s.autoTrigger = v; await save(); }));

    new Setting(containerEl)
      .setName("Answer cards")
      .setDesc("Show longer answers in a card you can fold away. Short answers stay plain text either way.")
      .addToggle((t) => t.setValue(s.cards).onChange(async (v) => { s.cards = v; await save(); }));

    new Setting(containerEl)
      .setName("Let Claude edit the note")
      .setDesc("When you ask it to fix, update or rewrite something, Claude changes that text in place. One undo reverts it.")
      .addToggle((t) => t.setValue(s.allowEdits).onChange(async (v) => { s.allowEdits = v; await save(); }));

    new Setting(containerEl)
      .setName("Web search")
      .setDesc("Let Claude look things up when a request needs facts or anything recent. Costs a little per search.")
      .addToggle((t) => t.setValue(s.webSearch).onChange(async (v) => { s.webSearch = v; await save(); }));

    new Setting(containerEl)
      .setName("Searches per tag")
      .setDesc("The most web searches one tag may run. 0 means no limit. Each search costs about a cent.")
      .addText((t) => t.setValue(String(s.maxSearches)).onChange(async (v) => { s.maxSearches = Math.max(0, Math.floor(Number(v) || 0)); await save(); }));

    new Setting(containerEl)
      .setName("Source links")
      .setDesc("Add a short link after facts Claude found on the web (three at most).")
      .addToggle((t) => t.setValue(s.showSources).onChange(async (v) => { s.showSources = v; await save(); }));

    new Setting(containerEl)
      .setName("Max answer tokens")
      .addText((t) => t.setValue(String(s.maxTokens)).onChange(async (v) => { s.maxTokens = Number(v) || DEFAULT_SETTINGS.maxTokens; await save(); }));

    new Setting(containerEl)
      .setName("Retry declined requests on another model")
      .setDesc("If Claude's safety checks decline a request, Anthropic re-runs it on a fallback model.")
      .addToggle((t) => t.setValue(s.refusalFallback).onChange(async (v) => { s.refusalFallback = v; await save(); }));

    new Setting(containerEl)
      .setName("Debug log")
      .setDesc('Write what each tag did (searches, errors, how the reply arrived) to a note called "Inline AI log" in your vault. It never includes your API key or your note.')
      .addToggle((t) => t.setValue(s.debugLog).onChange(async (v) => { s.debugLog = v; await save(); }));
  }
}
