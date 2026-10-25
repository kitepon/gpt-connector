# 製品core自身の原本を結ぶ最小port案

Dorothy operation observer520c241の次工程。これは型と責務/接続点の提案であり、実helper/CLI配線を実装しない。
`src/update-ledger-core-observer-ports.ts`だけを追加し、既存collector/provider/公開setupを変更しない。
import/型検査ではprocess観測・秘密/network/journal/file書込・Node/npm起動を行わない。

## 呼出し位置と元run

公開CLI src/cli.tsのsetup分岐で、installSetupPackageがnullを返した後、既setup()の直前がbeginの候補。
installed!==nullのlauncher/re-exec親、--help/Steer専用処理、package失敗をcore実runとして発行しない。
子が実際にsetupするなら、その子の同じ位置で自分のruntime/UID/GID/cwdを取得する。
工場JSのprocessやsetupの戻り値を受け取った別processでは代行しない。

製品の同processでprocess.pid/ppid/getuid/getgid/cwd/execPath/versionと実entryを一回保持する案。
Windows/macOSの不足をLinux値で補完しない。初回は既合意main-server/Linuxだけで、値取得は今は未実装。
shared one-owner Python helperが直接のproduct parentを/procで照合しboot/start/UID/GID/cwd/exeを記録する。
この新phaseと受渡しはDorothyとの共同契約が必要で、既520c helperが対応済みとはしない。
別helperをコピーせず、env全体/cmdline/認証/Node版コマンドを読まない。

helperは同private activation内のpublic_setup_before.json原bytes/SHA/長さを取得し、
launcher/工場親/実coreの祖先、観測時刻と有効期限、source pinsを照合する。
refは保存原本の所在から発行し、planやenvで自己申告されたSHAだけを信用しない。
前段が無い/別run/別process/登録source未採用はunknown。C#等の別runtimeや工場JSをNode採用へ代入しない。

ProductCoreRun.tokenは同core内で所有するopaque object。callerのmutable objectをprivate原本へ
snapshotし、tokenを別runに流用/再構築しない実装が必要。型だけでは真正性を保証しない。
run_idは製品が開始した元runを保持し、工場bridgeのIDから生成しない。既completion hookと併用するなら
元hook.beginの同runを渡し、observerのために台帳sender/leaseを有効化しない。

## 結果の結合

元setup result/exit分類は既cliのまま。ready/partial/action_required/failedをobserverで再判定しない。
writeJsonが実際に使うserialize結果の同bytesからSHA/長さを作り、別のJSON.stringify/canonical値に置換しない。
result_originalは既正規原本がある時のrefだけ。現CLIに保存原本発行口はまだ無いので、refを作ったことにせずnull/unknownにする。
raw結果を新規保存する必要があれば、その対象/秘密除外/保存先をshared helper側と別途固定する。
stdout write callback完了/失敗と元exit_codeを保存し、pipe送達/相手の読取成功へ昇格しない。
before→製品開始原本→同token/同kernel process→元結果original/digest/code/time→completeの一組を保存する。
元結果が無い/出力未確認ならunknownで、成功reportingへ進まない。

工場public_setup_afterのstdout SHAは通常command全stdoutの観測。製品serialized resultはその結果frameのSHA。
余分なstdout/package子が存在する可能性を無視して両者を同一にしない。元bytesの範囲/参照が一致する時だけ照合する。
observer出力を元stdoutへ追加しない。通常setupを二回実行せず、観測失敗は安全なunknown/WARNを別に残す。

## 所有と未成立

当席は製品coreの開始/結果接続点、元runtime自己観測、同run/token/結果refの保持を持つ。
Dorothyは同じhelperの新phase/原本store/祖先照合を持つ。Frはsource/scope/whole-source pin/実方式採用、
Emmaは自然job/host/private領域/最大48h一回解除を持つ。現型案は共同意味/最小fieldの合意用。

通常PR/必要CI/同tree反映・既定OFFを解除する方式は別gate。実host/cron/Node/npm/NVM/resource/state/ref/CLI有効化0。
fixture/宣言をnormal_job_binding/実health/全writer/Node採用へ格上げしない。本文のraw記録はreporting/resource許可falseを保つ。
実装後の必要focusedは別run/ref/親identity差替え、欠測、mutable alias、元partial/code維持、exact結果bytesの範囲/出力失敗。
今は宣言だけなので新成功試験を作らず、型検査だけで確認する。
