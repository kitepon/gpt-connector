export const rawCatalog = {
  default_model_slug: "gpt-thinking",
  models: [
    { slug: "gpt-instant", title: "Instant", reasoning_type: "none", thinking_efforts: [] },
    { slug: "gpt-thinking", title: "Thinking", reasoning_type: "reasoning",
      thinking_efforts: ["min", "standard", "extended", "max"].map(thinking_effort => ({ thinking_effort })) },
    { slug: "gpt-pro", title: "Pro", reasoning_type: "pro",
      thinking_efforts: [{ thinking_effort: "standard" }] },
  ],
  versions: [{
    id: "latest", enabled: true, intelligence_presets: [
      { id: 0, title: "Instant", model_slug: "gpt-instant", selected_display_version: "5.6", preset_type: "available" },
      { id: 1, title: "中程度", model_slug: "gpt-thinking", thinking_effort: "standard", preset_type: "available" },
      { id: 2, title: "高", model_slug: "gpt-thinking", thinking_effort: "extended", preset_type: "available" },
      { id: 6, title: "極高", model_slug: "gpt-thinking", thinking_effort: "max", preset_type: "available" },
      { id: 3, title: "Pro", model_slug: "gpt-pro", selected_display_version: "6", preset_type: "available" },
    ],
  }],
};
