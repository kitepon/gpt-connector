---
title: ChatGPT API clientの経路照合
acquired_at: 2026-09-19
source: 認証済みChatGPT WebのCDP読取りと公開操作の実測
confidence: 実測
---

# API clientの重複検出

shared module fingerprint `037b156802ee183f`で、標準clientと録音adapterがともに`safeGet('/models')`へモデル一覧を返し、既存の一意判定が`RUNTIME_DRIFT:apiClient:2`で停止した。

両者は同じprototypeを使うが、録音adapterは`/record`を`/meetings`へ変換する。現行request実装はpath変換、overrideBaseUrl、overrideUrl、Request生成、fetchの順に実行する。`overrideBaseUrl`を現在の公式originへ固定し、`overrideUrl`で解決済みpathnameを読むと同時に専用Symbolをthrowすれば、追加HTTP要求なしに標準経路を識別できる。minifyされたexport名は選択条件へ使わない。

両候補の/models成功を再現するfocused testを先に失敗させ、標準clientだけを選択し、fetchへ到達しないことを確認した。修理後、実ブラウザでdiagnostics ready・モデル一覧・Instantの短いChat成功を確認した。独立レビューでも例外identityとrequest実行順を確認した。

この観測は取得時点のruntimeについての証拠であり、恒久的なexport一覧ではない。
