# Codex親への単独Steer実測

取得日: 2026-09-13。確度: ローカル公式binaryと本製品コードで実測済み。
現行の操作契約は[Codexへの自動Steer](../../docs/codex-steer.md)を参照する。

## 根拠

- 参考に読んだ[Aiterm実装](https://github.com/kitepon/aiterm-mcp/tree/f2c196a798f78941bf0b22d14261ec0eb5f27a38/src)。launcher、stdio中継、setupをMIT条件で製品内へ移植した。実行時のAitermコマンド・設定参照は持たない。
- 公式署名binaryのSHA-256: `ecad78dbf98adb89ec475edac86630406cbe59d9f3070b17d88065f136b94bcb`。試験前後で一致した。
- 再現入口: `scripts/codex-steer-official.test.mjs`。空の一時HOMEとローカルHTTP Responses fixtureを使う。外部AI呼出し、実利用者の認証情報、Aiterm設定は使わない。

## 観測

- POSIX execを使うlauncherは公式App ServerのPIDと親子関係を維持した。
- 同じUnix WebSocketへDesktopを模擬したstdio接続と追加接続を並存でき、同じRPC IDでも応答が混ざらなかった。
- 実行中の`turn/start`は同じターンへ本文を注入し、終了後の`turn/start`は同じタスクの次ターンを開始した。双方の本文が次のモデル要求に一度ずつ含まれた。
- 承認要求はstdioへ届き、拒否応答も公式App Serverへ届いた。追加接続の終了で親接続は終了しなかった。
- stdio終了時は未完了のモデル要求と追加接続が残っていても公式App Serverを終了し、socketを削除した。
- 単独setupは自身のlauncher経由でinitializeと終了を確認してから起動設定を切り替え、解除で元の設定へ戻せた。GUI環境の実書換えはfixtureに置換し、利用中のDesktopは再起動していない。
- connectorの既定監視では受付時と約10秒後の2回で完了を検知し、追加の利用AI呼出しなしで配送した。

## 適用範囲

ここで実測したのは公式App Serverと製品の接続・配送処理である。実際のDesktop UIの再起動からの復帰はこのfixtureの対象に含まない。
回答生成の判定は既存page bridgeのsender完了と終端結果を使う。監視や配送に追加AIを起動する必要はない。
