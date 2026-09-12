# Windows setup修理と公開後確認（2026-09-12）

0.5.3でWindowsの設定バックアップを修理し、公開版をMacとWindowsへ導入した。

## 原因と変更

WindowsのGit Bashから0.5.2のsetupを呼ぶと、PATHでGit付属GNU tarが選ばれた。
バックアップ先の`C:`を接続先と解釈し、`Cannot connect to C: resolve failed`、終了128となる。
設定更新が必要なCodexだけ登録に失敗し、その時刻のバックアップは0バイトだった。
同じ引数をWindows標準tarへ渡すと終了0となることを実機で確認した。

`src/platform/setup-backup.ts`がWindows標準tarを直接選び、`src/setup-registration.ts`から呼ぶ。
既存値のマージ、認証、MCPの7ツール、state schemaは変更していない。
Windows回帰試験はGitのtarをPATHの先頭に置き、旧処理の失敗、登録成功、保存内容の一致を検証する。

## 検証結果

| 対象 | 実測結果 |
| --- | --- |
| 手元の製品検証 | lint・型検査・製品試験・build・release gate成功 |
| Windowsの修正処理 | Git tarは終了128、修正処理は元内容と一致する2048バイトのarchiveを作成 |
| Windows公開版の4AI setup | 0.5.3、4AIとも登録unchanged・MCP ready、既存設定保持 |
| Windows再実行・読取り専用診断 | 4AIの設定に追加変更なし、MCP ready |
| Windows公開版の登録回帰 | Git Bashの標準PATHのまま、隔離Codex設定を公式npm入口へ指定。登録成功、archive内容一致、再実行unchanged |
| Mac公開版 | このMacをローカル操作して0.5.3を公式導入。setup --checkは4AIともMCP・live ready、終了0 |

Windowsの`overall=partial`・終了2は、ブラウザ機能がMac限定であることを示す既存契約。
登録失敗は解消した。Windowsの実登録と認証・モデル・他MCPは保持されている。
Macではログイン後に0.5.2の通常setupが4AI readyとなり、0.5.3導入後は共有設定を変更せず診断した。

## 公開記録

- 修理commit: `a06e06364cb1518e676abdf28637c2163a0fcd93`（mainの祖先を確認してtag作成）
- [mainの3OS CI](https://github.com/kitepon/gpt-connector/actions/runs/34698167870): 成功
- [tagの3OS CI・npm公開](https://github.com/kitepon/gpt-connector/actions/runs/34698241298): 成功
- [0.5.3 Release](https://github.com/kitepon/gpt-connector/releases/tag/v0.5.3)
- [npm公開元証明](https://registry.npmjs.org/-/npm/v1/attestations/gpt-connector@0.5.3)

npmが公開受付直後に処理中と通知し、一時的に取得が404となった。通常の取得先に反映されてから導入した。
Linuxは製品CIで確認した。別作業が進行していたため、Linux実機への追加導入は行っていない。
