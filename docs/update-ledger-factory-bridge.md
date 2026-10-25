# factory writer receiptからreader viewへの境界

source-only。base8c94428とDorothy dcec5aa58104fe1106b0664b5cfa2502a9ba26a1の具体差分を対象とする。writer/readerの存在を実接続や実target採用へ代用しない。新OS/host/HTTP/native/鍵/CLI有効化は行わない。

## 呼出しと所有

Dorothyの`runNpmDeploymentUpdate`はEX区間の完了解放後に`readDeployment`でSHを取得し、`runPublicSetup({lease,receipt,package_name})`をawaitする。このcallback内から`runSetupWithFactoryReceipt(plan,scope,lease,receipt,ports,options)`を呼ぶ。bridgeとreaderはSHを再取得/解放しない。writerがcallback終了後のguardと解放を所有する。公開setupは導入済みcoreだけで、npm/re-execをSHへ戻さない。

現writerの最低lease契約はsignal/assertCurrentだけである。readerが必要とするmode=SH、resourcesの実集合と順序、generationの束縛は共通OS lock adapterの取得結果に必要。planやcallback到達だけから属性を付け足さない。欠けたleaseは公開setup前にblocked。共通adapterの実装/実resource/全writer参加は未受入。

## 原本と投影

`factoryCanonical`は固定writerと同じplain JSON/有限数・Object.keys.sortのbyte規約。ledger canonicalのlocale順と異なるため混ぜない。原receipt payload subject、outer receipt全体hash、reader view hashを別々に保存する。原proof/issuer_id/evidence_refはprovenance.factory_originalへ無変更で保持し、verifyReceiptは原payload subjectと既存trust/issuerを検証する。reader viewを原writerが発行/署名したreceiptと称しない。

| reader field | 採用元と必要照合 |
| --- | --- |
| identity / execution_prefix | 原payload identityとexecution_package_root。product/host/ownerを厳密検査し、rootをplanと別照合 |
| generation / state | 原deployment_generationとSH中に同じwriter storeから読むfactory stateのgeneration/committed。scope/原receipt完全一致 |
| manifest / revision / issuer / evidence_ref | 原manifest_sha256、deployment_revision、outer issuer_id/evidence_ref |
| tree / artifact_source | 既存provenance原本から検証したview。factory_payload_sha256/原provenance_evidence_refに束縛。artifact_or_tree_kindを明示して原digestと対応照合。単一の曖昧digestを両方へ流用しない |
| adoption original / projection | 原adopted_targets_sha256はwriterのverifyAdoptionが返したオブジェクト全体のfactory canonical hash。evidence_refや追加fieldsを含む。その正確なhash subjectを既存根拠から回収/検証し、payload.targetsとview.targetsも一致確認。planのtargetsから原本hashを作らない。collector向けtargets hashは別途ledger canonicalで算出 |
| coverage | 実mutation_resourcesと全writer参加を裏付ける既存agreement原本の検証済みview。all_writers=trueとcoverage_ref/実集合を照合。planや自己申告では不足 |
| node_runtime | 検証済みprovenance viewからのみ。原本が無ければnull、Node targetが必要なら既readerがunknown停止 |

readSourcesはprovenance/adoption/coverageをOriginalPacket+view+issuerで渡す。verifySourceは既存原本のsubject(factory canonical)とviewのhash(ledger canonical)の両方、既存issuer/trustと意味上の対応を検証する。これは既存原本を読む明示portで、新署名方式/新鍵基盤を要求しない。成功defaultや秘密/OS/networkの自動adapterは無い。欠測/unknown/意味未確定なら正常報告へ進まない。

必要共同差分はFr窓口で合意する。(1) artifact_or_treeの種別と独立tree/source原本、(2) verifyAdoption出力そのものの回収・元根拠、(3) 全writer参加coverage原本、(4) 実SH metadataの共通adapter、(5) 必要時共有Nodeの所有/実版原本。現writerはこの全部をreceiptから発行していない。既writerへの変更要否は原本/既portsの所在確認後に決める。架空refや実鍵を出さず、未成立を実接続済みにしない。

## 今回の最小確認

`GPT_LEDGER_WRITER_SOURCE`で固定writer deployment-writer.mjsを指定し、SHA256 42c11b7d1626ceee330766262b242e8ab0b9db8d5a2b52d27907d3085303120fを一致させてから、その実readDeploymentと橋を合成する。新5件だけ実行。単一SH保持とcallback/hook終了順、大小文字キーを含む原canonical subject/outer/view別hash、原本不足/原subject不一致/投影未検証、digest意味不明/採用全体hash不足/全writer未受入、lease metadata欠測/世代不一致/committed store変更、同run受入中のabortと元ready結果保持を確認する。

原本とtransport/lockは合成のoffline検査であり、実発行・実OS排他・全writer参加・実health採用を実証しない。外部writer pathが無い通常testではこのinterop試験はskipし、今回の保存実行では固定sourceを明示してskip0。旧17/9/cleanup2/前provider8は再走0。
