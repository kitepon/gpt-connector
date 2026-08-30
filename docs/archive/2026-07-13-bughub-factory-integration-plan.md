# BugHub factory 契約適合（Wave 6.0 / 6.1）

正本: dotagents `docs/plan_bughub-factory-integration.md` Wave 6.0 / 6.1  
対象: `gpt-connector` のみ。既存 AI installer 作業とは変更ファイル・commit を分離する。

## 目的

既存の Chat、consult、MCP、添付、durable job、`gpt-connector.diagnostics.v1` を壊さず、
BugHub factory が製品内部を推測せずに利用できる read-only diagnostics と、明示 opt-in の
local runtime-error aggregate を製品所有で提供する。送信・upload・会話作成・archive・job 作成は
この変更の対象外であり、追加しない。

## TODO

- [x] Wave 6 正本、worktree、既存 CLI／diagnostics／job store を実読して前提を確認する。
- [x] `doctor` を保持する別の `factory-diagnostics --json` versioned read-only 契約を設計する。
- [x] canonical dotagents config の厳密な `collection.enabled === true` だけを読む runtime store を実装する。
- [x] fixed code/template、SHA-256 fingerprint、集約、resolve/reopen、cursor/ack、retention を実装する。
- [x] owner-only atomic state、symlink/tamper 拒否、bounded snapshot、privacy negative fixture を実装する。
- [x] CLI と修正可能な connector 境界へ best-effort 観測を接続し、store 異常を固定診断で可視化する。
- [x] README、npm 公開 allowlist、変更履歴を更新する。
- [x] `pnpm check` と `npm pack --dry-run --json` を実行し、失敗があれば修正する。
- [x] 再現欠陥: `gpt-connector --help` / usage / version はCDP接続前に完結し、CDP_UNAVAILABLEを返さない（CLI subprocess fixtureで固定）。
- [x] 再現欠陥: runtime-error storeの異常終了後lockは、生存writerを奪わず5分でstale判定・回収し、残存lockはdiagnosticsを`unavailable`にする（死んだPID／生存PID fixtureで固定）。
- [x] 実装完了: true headlessを使わず、専用profile・loopback CDPでChromeを起動する製品所有launcherを追加した。cold startは窓なしChromeを起動後、browser CDPから最小化状態のChatGPT targetを作成・確認してからapp readyを待つ。既存endpointはapp probeより先に最小化する。lock待機はready deadlineを超え、重複起動を避ける。引数・順序・最小化・lock fixtureで固定した。
- [x] 実機確認: 現行macOSで同時cold startは`started` 1件／`already_ready` 1件へ収束し、新規専用Chrome PIDのWindowServer layer 0 on-screenを15秒・10msで監視して最大0を確認した。hidden=false・CDP minimizedのままmodelsとchat（`ACCEPTED_NO_FLASH_OK`）が成功し、chat後も0を維持した。show→startは0→1→0を確認した。showの最終真実はCDP stateでなくWindowServer PID/layer 0である。
- [x] P0: `browser show`、AUTH_REQUIRED時の同一専用window表示復帰、fullscreenを経由する最小化状態遷移、endpoint-only中断cold launchの安全なtarget作成回復を固定した。Chrome更新時はstart/models/chat/showのrelease smokeを行う。
- [x] flash-free lifecycle: cold Chromeはhiddenで起動し、background minimized targetの確認後に正規PIDだけをunhideしてprobeする。hiddenのまま運用しない。
- [x] factory diagnosticsはbrowser launcherと同じくmacOSだけをlive対応とし、Linux/WindowsをCDP不備ではなく`unsupported`へ固定する。

## 設計判断

- factory diagnostics は CDP 接続を読むだけで、ChatGPT runtime に mutation を送らない。host 非対応は
  `unsupported`、CDP/auth 未準備は `not_ready`、検査不能は `unverified` として分離する。
- runtime-error store は product-owned state にのみ保存する。collection OFF/設定不正時は state を
  作成せず、network I/O は一切持たない。
- 観測入力は固定 error code と時刻だけに限定する。prompt、応答、file/session/job/conversation ID、
  token/cookie、CDP dump、絶対 path、raw error/stack/stderr は API・保存・公開 JSON のいずれにも通さない。
