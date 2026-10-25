# HTTP source候補と通常配備・受入provider設計

Fr追補: Ed25519は信頼合意で署名を選ぶ場合の候補方式であり、BugHub wireの必須字段/必須鍵基盤ではない。以下の署名案を現在のwriter/receipt発行者・信頼起点の合意より先に完成させる条件へ変換しない。FrがDorothyへec5bcf0aで照会済みの既存writer/receipt/信頼起点の結果を先に受け、必要な方式と責務を確定する。同じ依存先への重複照会はしない。

6354a2fのcollector/sender/hook、wireと保守的health写像はFrにsource限定採用された。本書は次のsource-only差分。HTTP adapterは実装済み、以下のprovider発行/信頼/排他は具体設計であり、実providerの実装/採用・実target/health・配備先受入を完了としない。実ref/鍵は記入・発行しない。

## HTTP adapterの境界

`createLedgerHttpTransport(identity, { timeout_ms, credential, assertActive, fetch? })`を明示合成する。identityは4製品IDとhost/固定owner/prefix。timeout_msは1〜15000の明示値を構築時に固定する。credential/assertActiveは実行時に呼ぶ注入関数であり、import/生成時には呼ばない。環境変数・秘密参照loaderは持たない。CLIからの自動ロード/有効化はない。

credential(identity, signal)は`{ product_id, owner, bearer }`を返す。product/ownerの完全一致とBearerの形式をネットワーク前に検査する。実際の専用ref/発行範囲・失効/再発行の責任はFr。架空ref、管理token、runtime-report鍵の転用を許さない。assertActive(identity, signal)は下記の配備read lease/通常入口の有効な実行条件を検査し、credential取得前と取得後/HTTP開始前に呼ばれる。guard不成立なら秘密もnetworkも始めない。guardは他の実行条件の承認を代行するものではない。

固定originはhttp://192.168.1.2:39310、GET/POST pathは製品専用の2つだけ。任意URL/他product pathを拒否する。POSTはsenderがdurable保存したcanonical snapshot文字列を同一bytesで渡し、adapterで再生成/時刻更新しない。1MiBを超えるbody、非canonical JSON、余分な字段を拒否する。fetchは一回だけでredirect:error、credentials:omit、cache:no-store、referrerPolicy:no-referrer。3xx/follow済み/異なるresponse URLも拒否し、追送しない。

期限はactive guard、credential、fetch、streamのJSON読取まで全体に掛ける。外部AbortSignalでも中断でき、遅れてcredentialが返ってもHTTP開始前に中断状態を再検査する。responseはJSONかつ最大1MiB。失敗は固定codeへ変換し、生の例外/レスポンスbody/credentialを返さない。POST失敗は既存senderのdurable issued/unknownからGET-onlyへ進み、adapter自体にはretry/reset/journal操作が無い。

通常`--check`は既存hookがsenderを呼ばないため、HTTP adapterを注入した場合でもcredential/network/journal書込を0に保つ。sender/adapterの明示実行はcheckの一部へ追加しない。

## 誰が何を発行するか

通常配備の実行担当がdeployment receiptの発行者となる。現工程ではドロシー等の通常更新担当との受渡し合意をFr窓口で確定する必要がある。製品側の任意configや収集担当が、Git main・希望package版・manifestだけからdeployment receiptを自称しない。

deployment receiptは、通常配備/更新/戻しが専用prefixへ実際に反映され、実行物とNode/依存treeを確定した後、配備writerの排他区間内で発行する。署名対象は以下の非秘密payloadとする。空欄/unknownを成功証明に変えず、元の配備失敗記録は別に保持する。

| 字段 | 根拠 |
| --- | --- |
| schema / issuer_id / issued_at / evidence_ref | 配備担当の登録済み発行者・元UTCms・通常配備原本 |
| product_id / host_id / owner / execution_prefix | 合意した実行主体と正規化済み実prefix |
| deployment_generation | 当該prefixの配備/更新/戻しごとの新しい世代UUID |
| deployment_revision | 実際に入れた実行物へ対応するsource revisionと配布artifactの対応原本 |
| manifest_sha256 / artifact_or_tree_sha256 | 現用manifestと、検証済み配布artifactまたは実配備treeのdigest |
| adopted_targets_sha256 | 明示採用target/series/adoption_refのcanonical hash。engines/range/lockから作らない |

同run受入receiptは、合意した通常の受入担当/providerが同じ配備read lease内で、実際の通常入力/設定/利用経路の結果を確認して発行する。payloadはschema/issuer_id/evidence_ref、完全identity、deployment_generation/revision、run_id/mode、元UTCms、normal setup結果hash、required_clients、raw_health boolean|null、normal_pathとpassed boolean|nullを含む。rawのunknownと受入未実施はnullのまま残す。setup ready・fixture/controller成功・過去runの受入だけでpassedを発行しない。

## 信頼する入力と検証

発行者はFrと通常配備/受入担当が合意したregistryへidentity/prefix別に登録し、製品側はその登録済み発行者の非秘密public keyで署名を検証する設計とする。署名方式はEd25519、署名対象はschemaを含むcanonical payload。実鍵/registry/refの配布・保管は今回未実装・未合意であり、ここに仮の実行値を置かない。packet内の自己申告public keyや任意署名検証成功を信頼の起点にしない。

deployment providerは登録済みread-onlyのreceipt窓口から取得し、署名/issuer/identity/prefix、lease generation、実manifest/artifact digest、採用target hashを照合した後だけ、既存collectorの`DeploymentReceipt`4字段へ投影する。既存の4字段interface単独を署名済みreceiptと見なさない。通常配備receiptが欠ける、未登録issuer、世代/target hash/実体不一致なら停止する。過去receiptを現在runへ複製しない。

受入providerは登録済みの受入原本窓口から、同じrun_id/世代/revision/prefix、normal結果hash、required_clients、時刻窓を検証して既存health interfaceへ投影する。normal結果は通常入口が保持するcopy/hashと照合し、providerが元失敗をreadyへ書き換えない。健康値が未知・未実施・矛盾の場合はunknown/blockedとして残し、Frが合意した保守的写像へ進めない。

署名とread leaseのいずれか一方では不足する。署名は発行者と当時の主張を検証し、read leaseはその世代の実行物が当該run中に差し替わらない条件を保持する。

## 同じ配備世代を保持する排他

通常配備writerとsetup/check/報告のreaderが同じprefix単位のOS排他機構を使う。writerは独占、readerは共有とする。controllerの単なるbooleanやmanifest前後一致を配備排他の代用にしない。権限のないwriterによるprefix変更は受入対象外として実行を停止する。

通常入口は次の順で動く設計とする。

1. `withReadLease(identity, async lease => …)`で、setup/check開始前に共有leaseを取得する。取得できなければ通常run/receipt/secret/networkを始めない。leaseには正規identity/prefix/generationとAbortSignalがある。
2. 登録済みdeployment receiptを検証し、その世代の下で通常setup/checkを一度実行する。run開始/完了とresult hashは入口が所有する。
3. 同runの受入原本を検証し、実版の採取を行う。lease.assertCurrent()と実体digest/target hashを検査してからcollectorへ投影する。
4. 許可されたsetup報告だけでsenderへ進む。HTTP adapterのassertActiveは保持中leaseと実行条件を検査する。senderのdurable/CAS/issued/POST/独立GETの間も共有leaseを保持する。
5. definiteな期限で処理を終え、unknownならdurable pendingを残してleaseを解放する。leaseを握ったまま無期限pollしない。後続runは旧pendingのGET-onlyを守り、新世代のsnapshotを旧UUIDへ混ぜない。

lease喪失/終了/世代変更はAbortSignalで伝え、以後のcredential/networkを止める。POST開始後の中断は不確定であり、body/UUIDやjournal状態をresetしない。writerは全reader解放後にだけ配備を進め、新世代receiptを発行する。戻しも新世代/新しい実測として扱い、旧receiptの時刻を付け替えない。

OS排他の具体adapterと配備側への組込みは未実装。Linux/macOSはflockのLOCK_SH/LOCK_EX、WindowsはLockFileExの共有/独占範囲lockを候補とし、プロセスのhandle保持に結び付ける。子processへlock handleを不用意に継承させず、取得には明示期限を設ける。通常writerとreaderが同じ機構/対象を使い、プロセス終了時のOS解放と配備中断結果を受け入れる必要がある。孤立lockの推測削除・強制解除を回復手順にしない。journal排他lockは別責務であり、deployment lockの代わりにしない。Windows directory fsyncの耐久性も別の未受入条件として保持する。

`--check`のproviderは既に生成された同run原本の読取りだけを行い、署名鍵読取り/新しい署名/receipt・journal書込み/新しいnative受入/credential/networkを開始しない。同runの通常受入原本が無ければacceptance=nullとし、旧runの証明を流用しない。現CLIにはこのwrapperを有効化していない。

## source-only検査と次の条件

新規test/update-ledger-http.test.tsだけを実行する。import/生成/check無作用、固定pathとscope、exact body/redirect拒否、credential期限と遅着、guard失敗/安全なerror、bounded JSON、既存senderとのPOST不確定GET-onlyをofflineで確認する。署名/OS lock/providerの実装・実証をこの検査に含めたとは主張しない。

Frは専用ref/発行範囲の具体案を所有する。source設計の次の合意対象は、通常writer/受入発行者、trust registry/public key受渡し、artifact/treeのdigest原本、採用target hash、read leaseの実装と通常入口への組込みである。実target/health/provider/prefix/Windows耐久性/CLI有効化と実行範囲は未成立。今回の実HTTP adapter sourceを実GETPOST/秘密取得/host採取/公開配備/旧Ownerlater・Grokdisabled・SEC002・Windows3等の解除へ変換しない。
