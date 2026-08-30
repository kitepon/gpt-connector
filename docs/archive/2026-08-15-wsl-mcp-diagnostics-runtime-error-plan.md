# WSL MCP diagnostics runtime-error 修理

日付: 2026-08-15
対象: `gpt-connector`
状態: 完了

## 目的

live connector非対応hostでMCP `diagnostics`を呼んだ時、read-only診断が
`CDP_UNAVAILABLE`をhigh severityのruntime errorとして記録する不整合を直す。
診断は既存`gpt-connector.diagnostics.v1`のread-only結果を返し、Chat・consult・画像生成など
実操作で発生したCDP障害の観測契約は維持する。

## 原因

`factory-diagnostics`はLinux／Windowsを`unsupported`へ射影するが、MCP `diagnostics`は
`LazyConnectorHost.run()`でlive connectorへ接続し、接続不能を共通`toolResult()`へ投げる。
共通error処理が操作種別を区別せず`CDP_UNAVAILABLE`をruntime-error storeへ記録するため、
非対応hostのread-only診断だけでhigh severity記録が生成される。

## 非目標

- Linux／Windowsへlive browser connectorを実装しない。
- Chat・consult・画像生成など実操作のCDP障害記録を抑止しない。
- `factory-diagnostics`、runtime-error schema、既存Chat／job／attachment契約を変更しない。
- 既存runtime-error記録を無断でack／resolve／削除しない。

## 工程

- [x] clone直後のbaseline testをgreenにする。
- [x] MCP `diagnostics`が非対応hostでruntime errorを作る最小再現を固定する。
- [x] diagnostics専用のread-only doctor経路を実装する。
- [x] diagnosticsは正常なJSON結果を返し、runtime error storeを作らないことをfocused testで確認する。
- [x] 実操作の`CDP_UNAVAILABLE`は引き続き記録されることを回帰試験で確認する。
- [x] related test、full regression、lint、typecheck、build、pack dry-runを通す。
- [x] version／CHANGELOGを0.4.13へ更新する。
- [x] 対象限定commitを`origin/main`へpushし、release commit gateを通す。
- [x] H承認後、npm publish、WSLへのglobal install、MCP実診断、factory scanを確認する。

## 受入条件

1. Linux／WindowsでMCP `diagnostics`を呼んでも`CDP_UNAVAILABLE`をruntime-error storeへ追加しない。
2. 診断は`gpt-connector.diagnostics.v1`の固定shapeを正常応答として返す。
3. macOSのlive connectorが利用可能な時は既存の詳細diagnosticsを維持する。
4. Chat・consult等の実操作失敗は従来どおりruntime errorへ記録する。
5. 全test、release gate、公開後smokeがgreenで、成果が`origin/main`とnpmへ届く。

## 完了証拠

- 修正commit: `0ceaacd7b834d8eb735b1b1d9393ad4fabe1c22c`
- Windowsテスト隔離commit: `9e70fec15e344e4c4fea67afb8d1ef98d9bf6066`
- GitHub Actions: run `31856708877`でWSL2、Linux native、macOS native、Windows nativeが成功。
- 公開物: npm `gpt-connector@0.4.13`、tag `v0.4.13`。tarball shasumは
  `ffa0fe8786c9458a1d1c132c668aa80fb9cd6269`。
- WSL導入: global CLIとMCP serverが`0.4.13`。実MCP `diagnostics`は
  `gpt-connector.diagnostics.v1`の正常応答として`not_ready/cdp_unavailable`を返した。
- runtime-error store: 診断前後でcursor `3`、`CDP_UNAVAILABLE` occurrence `2`、
  `last_seen=2026-08-15T00:44:37.341Z`が不変。既存記録はack／resolve／削除していない。
- wire v7 fresh scan: report `320076c7-0543-4969-aa8f-ccbef2db52ea`、15製品、
  gpt-connector `installed_version=0.4.13`、version／state schema／job schema／migration／
  MCP contractがpass。WSLのlive connector面は契約どおり`unsupported`。
