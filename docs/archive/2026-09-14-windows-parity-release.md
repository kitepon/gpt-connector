# 0.9.1 Windows環境適合の修理・公開記録

2026-09-14、Windows対応をMacの既存制御へ統一した0.9.1を公開・導入した。

| 項目 | 結果 |
| --- | --- |
| 対象commit | `98604c64ba7c02d7271901e995c3879d3cdcb6e0`。mainへ着地後、祖先確認を行ってtagを作成 |
| Macの基準 | `449852c`の引数判定・中継・setup。処理順序と判断を共通コードへ移設 |
| Windowsの参考 | Aiterm `cf713a7`。nativeプロセスAPIとMSIXの実体パス処理を本製品へ移植 |
| ローカル最終検証 | lint・型検査、225件中208成功・17対象外、build、release gate、pack 148 files |
| main CI | [3OSとrelease commit gate成功](https://github.com/kitepon/gpt-connector/actions/runs/34771207361) |
| tag CI・npm | [3OS・main祖先gate・provenance付き公開成功](https://github.com/kitepon/gpt-connector/actions/runs/34771308199) |
| 公開版 | [0.9.1](https://github.com/kitepon/gpt-connector/releases/tag/v0.9.1)。npmからの取得とglobal導入を確認 |
| 公開入口 | repository外から `npx --yes gpt-connector@0.9.1 setup`。4AI登録・新規MCP接続・liveすべてready |
| setup再実行 | 公開CLIで全4登録unchanged。設定ファイルのhashも前後一致。`setup --check`終了0 |
| 単独動作 | 公開packageのコードを使い、隔離HOME・独自launcher・公式CLIでsetup、initialize、Steer、承認中継、EOF後終了の3試験成功 |
| MSIX | 仮想AppDataからのinitialize・EOF成功。実体パスへ引継いだことを確認 |
| 実配送 | 公開0.9.1の新しいMCPプロセスから、このCodexタスクへ完了通知を配送し、会話上でも受信 |

実配送の試験は `windows-091-platform-parity-20260914`。ChatGPTの回答は「Windows共通制御の配送確認済み」、状態はsucceeded、配送はsubmitted、stderrは空。2026-09-13 17:27 UTCに受付・配送を確認した。

この端末では既存の公式接続との互換性を確認して利用した。GUIのCODEX_CLI_PATHは変更していない。単独動作は別の隔離試験で確認し、Aitermのプロセス・設定・APIを使用しなかった。Macと同じ既存接続との共存を、Aitermを必須にする依存へ置き換えていない。

旧0.9.0の起動exeが稼働していないことを確認し、自分のcodex-steer設定領域をtarへ保存した後、旧config.jsonを同領域の `config-0.9.0-retired-20260914.json` へ退避した。現在の起動設定と食い違う旧所有記録を片付ける運用操作であり、共通setupへ移行用の別判定を加えてはいない。

初回の公開setupではCodex登録の不足項目 `args=[]`、`enabled=true`、`required=false` が既存の共通setupによって補完された。setupが作ったtarと事前hashが一致し、その他のCodex設定は構造比較でも一致した。残る3AIの設定ファイルは初回からhash一致。途中の「4AIすべて変更なし」という報告は誤りだったため、差分確認後に訂正した。

今回変更した製品コードは、共通の引数・中継・setupと、それを呼ぶOSアダプタに限定した。会話、添付、画像、監視、配送RPC、Chromeの共通制御は変更していない。旧Mac launcherの入口は引き続き利用できる。Mac・Linuxの実機上の旧launcher比較と共通試験はCIで確認し、Windowsの同梱CLI試験とMSIX試験はこの端末で行った。

登録済みMCPのツール定義をAIクライアントへ読み込む条件は、従来どおり新しいAIセッション。現在のCodex起動設定を変更していないため、今回の導入でCodex全体の再起動は必要なかった。
