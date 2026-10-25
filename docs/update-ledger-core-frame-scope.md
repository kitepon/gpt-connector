# core結果frameの保存範囲・上限案

Dorothy core-helper-agreement/protocol-proposal.mdへの製品側返却。共同source scopeへ提案する設計で、
validator/helper/CLI配線/保存を今有効にしない。型はupdate-ledger-core-observer-ports.tsのCoreFrameStorageScope。

## 対象bytesと上限

対象kindはsetup_v1_single_write_json_frame。install/re-execを終えて実setup/checkを行ったcoreの
writeJsonが一回だけ作るgpt-connector.setup.v1のUTF8 JSON＋末尾LF全bytesを対象とする。
実writeへ渡す同buffer/stringから一回snapshotし、観測用に再serializeしない。
--help/Steer専用結果/package失敗/任意stdout/stderr/MCP返信/工場全stdoutは対象外。

frame上限は65536 bytes（末尾LF込み）、control reply上限16384 bytes、helper子全体2500msを候補にする。
超過/不完全UTF8/末尾不正/別schema/複数frame/未知fieldはmetadata-onlyのunknown。
切り詰め/伏字/allowlist投影を正確な元frameとして保存しない。通常stdoutと元exitは変えない。

## 保存admissionのfield範囲

full frameを許可する前に、元source pinに束縛したstrict field検査を製品が所有する。
型名や64KiB上限だけで安全とは判定しない。scope案の範囲は次のとおり。

| 部分 | 対象とする値 | full-frameから外れる条件 |
| --- | --- | --- |
| top | schema固定/semver version/overall既4値/package ready/live.supported bool | 別schema、任意追加field、updateLedgerの未監査payload |
| registrations | 最大4・重複なしの既client、status/stateRead/clientActivationの既enum | server/env/command/args/設定本文や未知field |
| path/backup/cursorHooks.path | 元の製品registration/hooks receiptが持つ絶対path、各4096 bytes以内。private local metadataとしてFr scopeへ明示 | 別URL、制御文字、対応receipt無し、許可されていない保存範囲 |
| mcp/enabledTools | ready/not_checked、responded、元sourceの公開tools名だけ | tool本文/任意diagnostics/子process出力 |
| codexSteer/cursorHooks | 固定status/reason_code/connection、changed boolと上記pathのみ | 未知の外部library field、自由形式message/設定本文 |
| failure | 元公開stage/codeとsourceで列挙したreason_code | message/stack/任意例外本文 |
| live/next | 元prepareBrowser/結果生成の既status/reasonとsource固定案内文 | 任意URL/認証値/会話/自由形式text |

pathは既公開結果中のprivate所在地metadataであり、公開通知に転記しない。Frがその保存範囲を
採用しない間は該当frame全体を保存しない。外部Steer reason/message等の有限allowlistと
全nested schemaはまだ実装/採用されていないので、現時点で全通常frameを通過可能とはしない。
通常client選択や失敗結果を変えて保存しやすいframeへ迂回させない。

metadata-onlyは元schema/version/overallの検証済み値、元frame SHA/長さ、元exit/time/write状態と
同run/core_begin refだけを保持する案。本文を落としたmetadataをresult_originalにしない。
full frameが保存/読戻しされていなければresult_original=null/unknown。元partial/action_required/failedを
観測の都合でreadyへ変更しない。自己申告SHAや既保存refだけで安全性/来歴を満たさない。

## 一所有helperとの受渡し

新core_result専用子のstdin pipeへ対象frame bytesだけを送る。本文をargv/env/製品stdoutへ出さない。
元run/ref等の限定metadataは既合意phase portへ渡す。返却ref/kernel identityは捕捉fd3 pipeで受け、
親product stdoutへ転送しない。旧helper通常5/operationモードのstdout/stderr契約を変更しない。
pipeの取得/締切/close、partial frameと複数frame拒否、親終了時の子終了は新source実装の責務。

当席は同serialize bytes/field admission/元exit・write callback/同run token、Dorothyは同private0700
activationのfile0600非置換store/読戻しSHA/ref発行を持つ。store root/phase helperは複製しない。
書込中断は.pending原本を保持し、受入済みrefを捏造しない。write callback未完/保存ACK不明はunknown。
fd3返却やfile同期をfactoryの読取/中央受理/health成功へ昇格しない。

Fr新source scopeには上のframe範囲/上限/metadata-only停止、helper新phaseと実期待pinの信頼出典を
一組で提示する。実期待pins/自然job/保存先/一回48h解除はFr/Emma gate。既許可の通常更新や
Caveat反映を新frame保存/CLI配線へ流用しない。今回は設計/型だけで、新helper・試験・host/file作成0。
