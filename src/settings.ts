import { App, PluginSettingTab, Setting } from "obsidian";
import type InlineAIPlugin from "./main";

export interface InlineAISettings {
  apiKey: string;
  model: string;
  effort: string;
  tagWord: string;
  autoTrigger: boolean;
  contextChars: number;
  maxTokens: number;
  refusalFallback: boolean;
}

export const DEFAULT_SETTINGS: InlineAISettings = {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "medium",
  tagWord: "@ai",
  autoTrigger: true,
  contextChars: 6000,
  maxTokens: 16000,
  refusalFallback: true,
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
      .setName("Note context (characters)")
      .setDesc("How much of the note around the tag is sent along.")
      .addText((t) => t.setValue(String(s.contextChars)).onChange(async (v) => { s.contextChars = Number(v) || DEFAULT_SETTINGS.contextChars; await save(); }));

    new Setting(containerEl)
      .setName("Max answer tokens")
      .addText((t) => t.setValue(String(s.maxTokens)).onChange(async (v) => { s.maxTokens = Number(v) || DEFAULT_SETTINGS.maxTokens; await save(); }));

    new Setting(containerEl)
      .setName("Retry declined requests on another model")
      .setDesc("If Claude's safety checks decline a request, Anthropic re-runs it on a fallback model.")
      .addToggle((t) => t.setValue(s.refusalFallback).onChange(async (v) => { s.refusalFallback = v; await save(); }));
  }
}
