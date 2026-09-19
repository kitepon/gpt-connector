# 非同期相談のCDP切断後に接続が更新されない欠陥

取得日: 2026-09-19。根拠: Windows実機の公開MCP、製品コード、回帰試験。確度: 再接続不良は再現確認済み。調査中に一度発生したChrome自体の停止原因は未特定。

## 再現と原因

0.9.4で接続済みのMCPを保持したまま専用Chromeを終了し、正規の `gpt-connector browser start` で復旧した。
Chromeの接続口が戻っても、新しいslugを使った相談が2回続けて `CDP_UNAVAILABLE`・「閉じたCDP接続は利用できません。」となった。

`GptConnector.#runConsultJob` はCDP例外を失敗結果として台帳へ保存する。このため `LazyConnectorHost.run` の例外捕捉へ届かず、同じ接続が保持され続けた。
通常のthrow経路だけを扱う既存試験では、この結果データと例外の違いを検査していなかった。

## 修理と確認

相談がCDP失敗したことをconnector自身が保持する。MCPは次の要求で、旧相談の保存・配送の終了を待ってから接続を更新する。
同じ相談の再送、Chromeの自動再起動、失敗結果の成功扱いは行わない。

- 受付前・受付後の失敗を回帰試験へ追加し、修正前の失敗と修正後の成功を確認。
- 同時に来た2要求が一つの新しい接続を共有し、過去の失敗結果が引き続き取得できることを確認。
- 旧相談の結果保存に失敗した場合は、そのエラーを返し、新しい接続を作らないことを確認。
- 修正版のstdio MCPを実機で起動し、専用Chrome終了・再起動、初回の明示的CDP失敗、次の相談成功、同じ会話での合言葉保持、archive、最終 `ready`・保持session 0件を確認。

## 当初のChrome停止について

自発的に接続が失われた一件は、Windows Application・System・Security・Defenderの該当時間帯、Chrome Crashpadと更新ログ、並行タスクの操作記録から終了理由を特定できなかった。
復旧後の終了監視付き試験では、添付・継続相談・自動配送・接続診断で停止は再発しなかった。起動元の端末終了後も専用Chromeは継続した。
この修理が解決するのは切断後の接続更新であり、元のChrome停止原因が解決したという証拠にはしない。

参照: [相談とMCPの契約](../../README.md)、[継続相談の試験](../../test/connector-continuation.test.ts)、[MCP接続管理の試験](../../test/mcp-connector-host.test.ts)。

## 公開版の確認

修理を [0.9.5](https://github.com/kitepon/gpt-connector/releases/tag/v0.9.5) として公開した。
[main CI](https://github.com/kitepon/gpt-connector/actions/runs/35445746863) と [公開CI](https://github.com/kitepon/gpt-connector/actions/runs/35445823228) はMac・Linux・Windowsで成功した。
ローカルの製品試験は217成功・失敗0・OS条件による17スキップ。hook・release gate試験も成功した。

npmから取得した0.9.5をWindowsへ標準導入し、そのインストール先のstdio MCPで同じ切断・復旧・継続会話試験を実行した。
初回失敗 `CDP_UNAVAILABLE`、次の相談 `succeeded`、継続 `succeeded`、archive成功、最終 `ready` を確認した。
導入後のlive接続は4クライアントとも `ready`。導入直後のCodexは0.9.4を保持していたため完全再起動が必要だった。

## Codex再起動後の確認

再起動後のMCP診断で `packageVersion: 0.9.5`、setup診断で `codexSteer.status: ready` を確認した。
この時点では専用ChromeのCDPへ接続できなかったため、正規の `gpt-connector browser start` で起動した。起動後のsetup診断は全体・4クライアントとも `ready` になった。

最初の相談 `smoke-095-postrestart-20260919-ruri824` は `CHAT_FAILED`・`Something went wrong.` で失敗した。失敗通知は親タスクへ自動配送され、台帳も `failed`・配送 `submitted` だった。接続診断は引き続き `ready` で、CDP切断は起きていなかった。この回答失敗の原因は特定していない。

続く新規相談 `smoke-095-postrestart-20260919-hisui936` は、既定のPro（実行モデル `gpt-6-pro`）で `動作確認完了：翡翠936` を返した。親タスクへの自動配送、`finished_successfully`、archive成功を確認した。最終診断は `ready`、保持session・実行中jobとも0件だった。
これにより、公開版0.9.5のCodexへの反映と実際の回答の自動配送まで確認を完了した。当初のChrome停止原因、および今回一度発生した回答失敗の原因まで解決したとは扱わない。
