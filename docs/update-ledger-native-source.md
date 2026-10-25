# 製品journalのnative接続source

Frが07:45に採用した境界に従い、共通Linux fixture helper/EXSH/deployment CAS/evidence storeはDorothy一所有。当席は借用SH→既reader/同run終了と製品journalを持つ。実host prefix/CLI/HTTP/ref/Node/他OSへは接続しない。

## storageと排他の整理

fileLedgerJournalのphase/UUID/exact body/受領照合は再利用する。storageが実uid/mode、directory/file種別、symlink/realpath・同dev/inode・hardlink、開いた実体とpathの一致を確認し、file sync/parent directory sync後だけ新currentへ進める。既存directoryを0777、fileを0660にした実Linux反例では、旧sourceはcallbackへ進みbefore2fail。修理は不足権限を黙ってchmodせず、元mode/bytesを保持して停止する。

排他は明示withExclusiveLease portへ分離し、同helperから返る実mode=EX/resources=[正規directory]/signal/assertCurrentを検査する。fixed OS lockを製品側で作成/置換/削除しない。nativeLedgerJournalは保持中deployment SHの元objectをparentLeaseに渡し、別journal resource EXを取り、逆取得/早期解放をしない。journal parentにはgeneric SHとして必要なmode/resources/signal/assertCurrentだけを要求し、generic leaseへ世代を捏造しない。providerが使うdeployment世代は同helperのwithReadLeaseが実storeを読む別責務。

旧wx方式は既呼出互換として残すが、native modeでもoperation.lock残留は明示停止する。OS lockを取れたからといって旧孤立lockやpendingを削除/新UUIDへ作り替えない。新native rootでOS lease解放後の再取得を使う復旧は、同helper固定sourceによる有限process fixtureで別に受け入れる。

## 新しい実FS結果と未了

新test/update-ledger-journal-native-permissions.test.tsだけをLinux自席artifacts/2026-10-25-update-ledger-native/fixtures配下で実行。修理後は上記2権限拒否と、実0700/0600・prepared→issued sync・reopen時の同body/hash/phase・非秘密bytes不変の新positive1件を合わせpass3/fail0/skip0。fake FSは使わない。型/変更lint成功。

この3件は実FSの原本で、共通helper OS排他やkill/restart GET-onlyの完成ではない。Dorothy固定source/hashの受領後、同helperでのdeployment SH→journal EX/同run callback終了、取得期限/lease喪失、中断と再起動で同UUID/bodyを保ったGET-onlyを必要最小の実process fixtureへ接続する。OS crash/power-loss保証は0。Windows directory metadata durability・別principal/remoteFS・実prefix/全writer/trust/ref/target/Node/CLIは未受入を保持する。import/生成でhelper/FS/秘密/HTTP/journal操作を自動開始しない。
