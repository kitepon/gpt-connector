# Windowsの環境適合とMacの共通制御

取得日: 2026-09-14。根拠: 実コードの比較とWindows実機でのfocused test。確度: 以下の試験範囲で確認済み。

Macの基準は本製品の `449852c`。Windowsの参考は[Aitermの対応完了時点](https://github.com/kitepon/aiterm-mcp/tree/cf713a7)の `windows-codex-native.ts`、`windows-codex-launcher.ts`、`windows-codex-relay.ts`とMSIX試験。移植コードの所有者はgpt-connectorとし、Aitermのインストール・起動・APIを使わずに動く。

0.9.0ではWindows専用の中継ループとsetupの判定が存在し、公式Codexの親が中継Nodeになっていた。通信は成功したが、Macと仕組みを共通にする条件を満たしていなかった。旧完了判定を撤回した。

Macの引数判定を二巡のままTypeScriptへ移し、中継ループは接続・生存確認・終了APIだけを引数へ出した。設定判定はMacの既存関数へ統一し、Windowsは環境APIを供給する。Aitermで修正されていた他の共通ロジックを本製品へ一括コピーしてはいない。

Windowsの公式Codexは起動元の直接の子、中継Nodeは公式Codexの直接の子として生成する。起動exeはプロセスの終了監視だけを行い、JSON-RPCの本文を通さない。Windowsの起動exeと公式CodexのPIDは異なる。POSIXのexecとPIDまで同じとは扱わない。

Windows実機では、公式CLI 0.154.0-alpha.6.2を使う独立した試験で次を確認した。

- 単独setup、公式initialize、元の設定への解除。
- 直接の親子関係、RPC IDの接続間分離、追加接続を閉じた後も本接続が続くこと。
- 実行中の同じターンへのSteer、終了後の同じタスクへの配送、本文がそれぞれ一度だけモデル要求へ入ること。
- 承認要求と拒否応答の中継、待機中のEOFでの終了、接続情報の削除。
- MSIXの仮想AppData名から、native子へ実体パスを渡した場合のinitializeとEOF。
- 稼働中の別launcherによる公式接続との互換性。接続記録の生成時刻はCIMの桁表現が異なるため、同じ時刻として照合する。

MSIX試験の最初の失敗は、pnpmのjunctionを仮想フォルダへ引き継いだ試験配置が原因だった。製品起動前にzodをimportできなかったため、試験で使用するwsとzodを通常のファイル配置へコピーし、再試験した。製品の依存解決に代替経路を加えてはいない。

製品の受入条件と実行入口は[Codex Steer契約](../../docs/codex-steer.md)を参照する。この記録は時点の証拠であり、現行versionの案内には使わない。
