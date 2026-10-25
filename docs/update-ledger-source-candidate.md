# 更新台帳source候補（Frレビュー用、未公開・未接続）

6354a2fのsource/wire/保守的health写像はFrがsource限定で採用済み。次の差分としてsrc/update-ledger-http.tsに明示注入型のHTTP adapterを追加した。CLIは既定無効、実credential/API/host/配備は未実施。adapterの引数と、通常配備receipt/同run受入providerの発行・信頼・配備排他の具体設計は[update-ledger-provider-design.md](update-ledger-provider-design.md)を参照する。以下の「HTTP adapter未実装」「Fr設計合意前」は6354a2f時点の履歴であり、実target/health/provider/実行条件は引き続き未成立。

固定契約はFrのServerManager-work-units-release-01e7241/bughub/UPDATE_TARGETS.mdと同src/update-{contract,store,router}.js。実装はcollector、contract/同run検査、durable journal、sender、通常完了hookに分けた。既存runtime-error reportingは流用せず、元runtime issueの解決とは別工程とする。

## 入口と引数

通常の`setup({ ...options, updateLedger: hook })`で任意hookを明示注入する。CLIはhookや設定をロードせず、既定で無効。`createInstalledLedgerCompletionHook(plan, ports)`が通常run開始時にUUID/開始UTCmsを作り、終了結果のcopyを受け、deployment/health providerと実行prefixから実測を束縛する。採取後の完了UTCmsまでを同runの観測窓とする。

`plan`はproduct_id、host_id、固定owner、execution_prefix、source_wire_agreement_ref、health_agreement_ref、required_clientsとtargetsを持つ。product_idはgpt-connector-{mac-kite,main-server,rabbit,windows-workstation}の4つ、ownerはbellteam:bot-7696018a。hostとproductの組合せを検査する。

targetsは`{ component, target: { kind: "npm", name, series } | { kind: "node", series }, adoption_ref }`。各seriesと採用根拠参照は明示設定が必須。実際の採用系列は未確定であり、この候補に本番用の系列や合意参照を埋め込んでいない。テストの0.16、Node24等は合成入力である。

ports.deployment(start)は通常配備の非秘密receiptから`{ execution_prefix, manifest_sha256, deployment_revision, evidence_ref }`を返す。実行prefixの実package manifestとhashを一致させ、実導入版を読む。Nodeは実行processの版、npm依存はこのinstallationから実際に解決されるmanifestの版を読む。sourceの希望版・engines/range・lock・Git mainや候補revisionを現用へ代入しない。採取前後のmanifest hashとprefixが変わった場合は拒否する。deployment receiptそのものの発行主体/信頼性と通常配備中の排他は、接続合意時に通常配備担当と確定する。

ports.health(start, result)は`{ run_id, observed_at, raw: boolean|null, acceptance: null | { run_id, observed_at, source_revision, execution_prefix, normal_path: true, passed, evidence_ref } }`を返す。measurement、health、acceptanceのrun/prefix/revision/観測窓とsetup result.versionを照合する。通常結果のhash、元UTCms、測定値、採用根拠/合意参照を同runのevidenceとして保持する。

## health対応の案（Fr合意前）

raw=null、acceptance欠測、実導入版/系列根拠/配置revision欠測ではwireを作らない。nullをfalseにしない。healthy=trueにはraw=true、同runの通常受入passed=true、setup overall=ready、required_clientsすべてのstate/MCP/live readyを必要とする。setup readyだけで正常受入成立を代用しない。raw=falseかつ同runの受入passed=false、通常結果もreadyでない場合だけ既知の不正常をhealthy=falseとして表現する。値の矛盾は停止する。

required_clientsは合意した実受入対象を明示する欄であり、既存Windows3未受入やGrok無効化を変更するものではない。--checkは採取と判定のみ。senderを注入してもGET/POST/journal書込みをせず、読取専用の既存条件を保つ。送信器の明示呼出しは別に扱う。

## wireと送信状態

originは既固定のhttp://192.168.1.2:39310。GET /api/updates/v1/products/{product_id}、POSTは同pathの/snapshots。transportはproduct/host/owner/prefixを明示した注入interfaceだけで、HTTP adapter、credential発行/参照/秘密読取は実装しない。専用credentialのbindingと実発行範囲、adapter設定はFrのsource/wire合意後に確定する。

POST bodyは厳密に`{ request_id, expected_version, observed_at, deployment_revision, healthy, bindings: [{ component, target, installed, status: "active" }] }`。product/ownerは専用path/認証と独立GETで確認し、余分なsource/evidence欄をwireへ足さない。Node/npm以外は今回のcollector対応外。不明な実版では正常snapshotへ進めず、既存targetの省略をremovedへ変換しない。

送信器はfresh専用GETのinventory_versionをCASへ使い、UUID/body/hash/CAS/元観測/evidenceをjournalへfsyncする。全fieldのもう一度のfresh GETが一致した場合だけ、issued intentをfsyncして一回POSTする。保存失敗ならPOSTしない。HTTP応答の有無にかかわらず独立GETで、metadata/owner/inventory/元UTCms/revision/healthy/bindingsを確認する。bindingsは同契約どおり省略旧対象をreported=falseで残す。POST receiptと独立GETの全field一致までconfirmedにしない。

prepared/issued/unknown/observedがdiskに残っている再開はGET-only。request/bodyの変更、新UUID、reset、自動POST再送のAPIは無い。GETが期待snapshotに一致しても、durableなPOST receiptが無ければobservedに留める。GETはrequest_idを返さないため、観測一致をrequest受付の証明にはしない。新runから古い操作を確認した結果はoperation_run_idで区別し、hookはprevious_operationとして現在runの成功へ混ぜない。

journalは製品ごとの専用directoryと排他lockを使い、追記・file fsync・directory fsyncを完了してから次へ進む。断片行、破損、不変bodyの変更、孤立lockは停止し、自動修復/削除/解除しない。2MiBを超えたjournalは自動切捨てせず停止する。Windowsのdirectory fsync/実機耐久性は未受入で、失敗時に永続化を省くfallbackは持たない。接続前に配備先の永続保存条件を確認する。

## source-only検証と残条件

`node_modules/.bin/tsx --test test/update-ledger.test.ts`の新規17件、`tsc -p tsconfig.json --noEmit`、変更7ファイルのeslint。合成input、合成installation、偽transport、ローカルjournalだけを使用した。旧成功群/native/実席/host/実APIの検証は再走していない。

未確定はFrのsource/wire/health合意、実採用target系列と根拠、通常配備receipt/health受渡し、実行prefix/永続保存の受入、専用ref/発行範囲、実HTTP adapter/通常CLIへの有効化、実接続とreceipt/中央反映である。今回のsource受入を公開/配備/host採取/実認証/実GETPOSTの許可へ読み替えない。旧prepared packetの未知値と旧Ownerlater/Grokdisabled/SEC002/Windows3の停止条件を維持する。
