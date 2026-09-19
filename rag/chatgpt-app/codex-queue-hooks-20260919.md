---
source: https://learn.chatgpt.com/docs/hooks
retrieved_at: 2026-09-19
confidence: high（公式仕様と公式binary実測）
content_kind: compiled
---

# Codex公式キューと同期hookの単独配送

[公式原文](raw/codex-hooks-20260919.md)。PostToolUseのadditionalContextとStopのblock/reasonで同じターンへ結果を取り込む。
hookは並行し、承認は現在のhashへ束縛される。gpt-connectorは自分の2登録を照合・承認し、他の未承認hookは変更しない。

隔離HOME・ローカル模擬モデル・公式Codexの通常stdioで7条件を実測した。Aitermのpackage・設定・状態はfixtureへ渡していない。

| 条件 | 結果 |
| --- | --- |
| PostToolUse／Stop | 同一ターンで本文を1回だけ受信 |
| ターン終了後 | 同じタスクを公式キューから再開 |
| hook消失／終了境界 | 公式キューで1回だけ受信 |
| 利用者入力との共存 | hookは製品の回答だけを取得し、利用者入力は通常キューへ保持 |
| 未承認の他hook | 他hookの承認状態を保持して製品回答を受信 |

unitでは出力失敗・削除拒否・取り出し中断・競合・本文改変・ページ送りを確認した。
Windowsの再起動判定は旧cacheのbinaryと大小文字差を含める。CODEX_HOME削除時は保存回答を回収可能にし、配送だけunknownとする。
旧台帳version 1・2・3は読取りで変更せず、初回書込みだけbackupを保存してversion 4へ移行する。

fixtureは実ChatGPT・利用者のDesktopを操作しない。公開後の実環境確認はrelease工程で別に行う。

同日、公開packageの実装を使うWindows native試験でも全7条件が成功した。試験の親はWindowsの標準環境変数PATHEXTを継承し、終了時はprocess exitに続くstdioのcloseまで待つ。PostToolUseの発火には公式dynamicToolsの固定応答を使うため、OS shellやsandbox導入状態へ依存しない。Macでも同じfixtureの7条件が成功した。
