# Codexの通常起動を保つ親配送

日付: 2026-09-19。判断: 採用。

旧方式は親Codexの起動へ中継を挿入し、その接続を新規相談の前提としていた。通常stdioの親では
`PARENT_DELIVERY_UNAVAILABLE`になり、Node更新や中継消失がCodex自身の起動にも影響する。

新規相談はCodexの要求metadataとCODEX_HOMEへ束縛し、独立した公式App Serverから公式キューへ一度だけ投入する。
実行中はgpt-connector所有の同期PostToolUse／Stop hookが回答を取り込み、終了後は公式キューが再開する。
このためCodexの実行file・起動設定を変更しない。setupは自分のhookだけを公式APIで承認・読戻しし、その後に自分の旧中継を解除する。

状態と設定はgpt-connectorが単独で所有する。Aitermは方式の参照元であり、実行時依存・設定共有はない。
MacとWindowsで同じ状態遷移を使い、OS差は公式binary探索・プロセス識別・引用・権限だけに置く。
取り出しは配送ID・本文hash・単一claimで相関し、出力失敗をunknownとして保存する。旧台帳を読めるversion 4を使う。

独立レビューでは、Windows更新前のbinaryを再起動対象に含めること、CODEX_HOME消失をclaim不在と区別することが必要と判明した。
両方をfocused testで再現・修正した。他製品のhookを承認・解除する案、親の起動中継を継続する案、新方式から旧中継への自動切替は採用しない。

現行手順は[Codexへの自動Steer](../codex-steer.md)。実測は[公式hook調査](../../rag/chatgpt-app/codex-queue-hooks-20260919.md)を参照。
