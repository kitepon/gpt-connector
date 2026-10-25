# 製品journalのnative接続source

Frが07:45に採用した境界に従い、共通Linux fixture helper/EXSH/deployment CAS/evidence storeはDorothy一所有。当席は借用SH→既reader/同run終了と製品journalを持つ。実host prefix/CLI/HTTP/ref/Node/他OSへは接続しない。

## storageと排他の整理

fileLedgerJournalのphase/UUID/exact body/受領照合は再利用する。storageが実uid/mode、directory/file種別、symlink/realpath・同dev/inode・hardlink、開いた実体とpathの一致を確認し、file sync/parent directory sync後だけ新currentへ進める。既存directoryを0777、fileを0660にした実Linux反例では、旧sourceはcallbackへ進みbefore2fail。修理は不足権限を黙ってchmodせず、元mode/bytesを保持して停止する。

排他は明示withExclusiveLease portへ分離し、同helperから返る実mode=EX/resources=[正規directory]/signal/assertCurrentを検査する。fixed OS lockを製品側で作成/置換/削除しない。nativeLedgerJournalは保持中deployment SHの元objectをparentLeaseに渡し、別journal resource EXを取り、逆取得/早期解放をしない。journal parentにはgeneric SHとして必要なmode/resources/signal/assertCurrentだけを要求し、generic leaseへ世代を捏造しない。providerが使うdeployment世代は同helperのwithReadLeaseが実storeを読む別責務。

旧wx方式は既呼出互換として残すが、native modeでもoperation.lock残留は明示停止する。OS lockを取れたからといって旧孤立lockやpendingを削除/新UUIDへ作り替えない。新native rootでOS lease解放後の再取得を使う復旧は、同helper固定sourceによる有限process fixtureで別に受け入れる。

## 新しい実FS結果と未了

新test/update-ledger-journal-native-permissions.test.tsだけをLinux自席artifacts/2026-10-25-update-ledger-native/fixtures配下で実行。修理後は上記2権限拒否と、実0700/0600・prepared→issued sync・reopen時の同body/hash/phase・非秘密bytes不変の新positive1件を合わせpass3/fail0/skip0。fake FSは使わない。型/変更lint成功。

この3件は実FSの原本で、共通helper OS排他やkill/restart GET-onlyの完成ではない。Dorothy固定source/hashの受領後、同helperでのdeployment SH→journal EX/同run callback終了、取得期限/lease喪失、中断と再起動で同UUID/bodyを保ったGET-onlyを必要最小の実process fixtureへ接続する。OS crash/power-loss保証は0。Windows directory metadata durability・別principal/remoteFS・実prefix/全writer/trust/ref/target/Node/CLIは未受入を保持する。import/生成でhelper/FS/秘密/HTTP/journal操作を自動開始しない。

## 一所有helper539896との実process接続

Dorothy固定539896bd38d0e0da7600139d30fdb767212deca4のlib/factory/linux-fixture-native.mjs（64bd2db2522bb5d4cdcc0da0ed0b76890e214f2bbd758181b1cea3643962623e）と唯一Python helper（932e4e88fcafc8c6a53f9c2fa6d56279e8b65f87fc1e840f6a4730520f7c2ff6）を実pathからimport。排他helperのコピーは0。各自席fixtures/<UUIDv4>/resources/{deployment,journal}を0700で作り、callback外でprepare(sortedResources)、実EX下でmutating→committedを保存してから実withReadLeaseへ入る。

新test/update-ledger-native.test.tsの3件だけを実行しpass3/fail0/skip0。既FS3件とは別の新不足で、旧Dorothy13/19/6・reader4/bridge6/17/9/cleanup2/provider8は再走しない。

1. 実committed generationを持つ単一SHの原objectを既providerと公開core setupへ借用接続。fixture上のmanifest/entry実bytes、collector、別journal EXの実helper、file/parent syncを通す。transport/client/受入発行者/trustは明示synthetic。fake GET3/POST1/独立GETとhook settle後もparent SHを検査、journal confirmed/body一種類・0600を確認した。実OS lease/resource/generationと同run保持の証拠であり、実health/trust/HTTPの成立ではない。
2. 同run受入中に自分が起動したparent helperの実PIDだけをSIGKILL。報告はblocked/POST0、公開coreから得た元ready結果は別に保持し、外側native leaseも喪失を拒否する。成功結果への書換え/fallbackは使わない。
3. 別のowned Node producerが実journalへissuedを同期し、fake POSTの副作用witnessを同期して応答を待つ所で、そのproducerだけをSIGKILL。再取得した同native SH→journal EXで元issued/UUID/bodyを読み、GET1/POST0でobservedへ進む。GETはrequest_idを返さずpost receiptも無いためconfirmedへ格上げしない。native rootに旧wx operation.lockを作成しない。helperのstdin EOF後にOS排他が解放され再取得できたことを実証した。

rawlog、root/run UUID、実helperPid/leaseId/lock inode/filesystem、phase/body hash/GETPOST数はartifacts/2026-10-25-update-ledger-native/{native-tests.raw.log,native-observations.json,fixtures/}に保存。実FSは同helperが検査した当該Linuxで、OS crash/停電/drive cacheの保証0。実prefix、全writer参加/Node/既存trust、API/ref/CLI有効化、macOS/Windowsへ昇格しない。実host操作やAI CLI起動/認証は0。次の独立採否・実対象gateをFrへ返す。
