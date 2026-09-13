# ChatGPT「最新」スライダー定義の取得記録

出典: ログイン済み公式ChatGPT Web runtimeの `/models?supports_model_picker_upgrade_presets=true`、`versions[id=latest]`。
取得日: 2026-09-13。確度: 当該アカウントで取得した応答の抜粋。現在の選択肢の正本として固定利用しない。

```json
{
  "id": "latest",
  "display_text": "最新",
  "display_text_full": "最新",
  "display_text_for_intelligence": "最新",
  "short_display_text_for_intelligence": "最新",
  "slugs": [
    "gpt-5-6",
    "gpt-5-6-instant",
    "gpt-5-6-thinking",
    "gpt-6-pro"
  ],
  "enabled": true,
  "intelligence_presets": [
    {
      "id": 0,
      "title": "Instant",
      "subtitle": "5.6",
      "selected_display_title": "Instant",
      "selected_display_version": "5.6",
      "model_slug": "gpt-5-6-instant",
      "lane": "instant",
      "preset_type": "available"
    },
    {
      "id": 1,
      "title": "中程度",
      "subtitle": "5.6",
      "selected_display_title": "中程度",
      "selected_display_version": "5.6",
      "model_slug": "gpt-5-6-thinking",
      "lane": "thinking",
      "thinking_effort": "standard",
      "preset_type": "available"
    },
    {
      "id": 2,
      "title": "高",
      "subtitle": "5.6",
      "selected_display_title": "高",
      "selected_display_version": "5.6",
      "model_slug": "gpt-5-6-thinking",
      "lane": "thinking",
      "thinking_effort": "extended",
      "preset_type": "available"
    },
    {
      "id": 6,
      "title": "極高",
      "subtitle": "5.6",
      "selected_display_title": "極高",
      "selected_display_version": "5.6",
      "model_slug": "gpt-5-6-thinking",
      "lane": "thinking",
      "thinking_effort": "max",
      "preset_type": "available"
    },
    {
      "id": 3,
      "title": "Pro",
      "selected_display_title": "Pro",
      "selected_display_version": "6",
      "show_version_in_latest": true,
      "model_slug": "gpt-6-pro",
      "lane": "pro",
      "preset_type": "available"
    }
  ]
}
```
