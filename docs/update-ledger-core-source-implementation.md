# 製品core gateと共同helperのsource実装

Fr採用のframe scope345b68f/共同protocol976f22eeに対する実装。source branchだけで、main/配備/CLI観測有効化は0。
通常JSON formatterと既案内文を小moduleへ共有化したが、既writeJson出力/案内文のbytesを変えない。
新observerをCLIから自動起動する配線はない。live expected-pins/provenance adapterも未接続。

## 一回のserialize/parseと全nested gate

public-json.tsのserializePublicJsonへ元writeJson本体を移し、通常CLIも同じ一実装を使う。
明示createPublicJsonFrameではその元serializeを一回だけ呼び、上限内なら標準JSON.parseを一回行う。
元textとparse snapshotをprivate WeakMapへ保存。gateは同issued frame objectから既parse値を読むだけで、
別parser/二度目のparse/別serializeを持たない。fake rawbytesやcloneしたframe objectは元frameにならない。
将来の有効coreはframe.textそのものを元writeへ一回渡す。通常writeJsonをもう一回呼ばない。

update-ledger-core-frame.tsはtopからregistrations/mcp/tools/codexSteer/cursorHooks/live/failureまでstrict検査。
公開client/tools/error codeは既source定義を再利用し、案内textは元setupと共有する。
field外/任意message/env/server/未監査ledger、未列挙reason、制御文字/URL、path4096B超/全frame65536B超はmetadata-only。
所在地をfile操作先/refに用いず、source gateがreceipt本文を追加で読むこともない。
元frameの投影/伏字/切詰めを行わず、SHA/bytes/decision/reasonだけをframe_admissionへ結ぶ。

## 元process/run/outputの保持

createProductCoreObserverは一activationのbeginを外部port前に予約し、helperの実kernel/core_begin原本と
product自身のruntime/UIDGID/cwdを照合してimmutable run object/private tokenを発行する。
完成結果はissued completion objectへ限定し、別object/token/同completionの別run流用/再度の元run発行を拒否。
result helper呼出しも先に共有Promiseを予約し、同期再入でも一回だけ。

createCoreWriteObserverは元一回のwrite callbackへ取り付ける観測口。callbackの完了/失敗と元exitを保持し、
frameを再出力しない。callbackが未完ならcompletionを発行済みにしない。元partial/code2や通常stdoutを変更しない。
helper controlはmode/run/runtime/core_begin refとcompletionの限定fieldだけ。frame本文は別stdin pipe。
未許可frame/出力未確認では本文を送らず、helper metadata-only/unknownとprivate元reasonを保持する。
refはhelperの実読戻しhash/bytesへ一致したものだけ。fixture_core/observed_coreも混同しない。

## 425188e helperとの新しい結合

Dorothy固定425188e84bbd515baf74463448b7c3bf1082294eの14参照/4Git source/patchを読取照合。
producer14 unittest/26processは保存結果として扱い、当席で再走しない。
新2結合は当席UUID専有Linux領域のfactory親→product子→既一所有Python helperを使う。
fixture adapterだけが明示fixture policy/gate seamを注入し、実expected-pinsや自然jobを成立させない。
helper entry/storeをコピーしない。full frameは同bytes非置換0600保存/読戻しfd3、unknown frameは原本null。

初期fixtureはfactory/coreを同一processに置いたため正しくfactory_parent_not_ancestorで拒否された。
条件を緩めず、別の実親子processへ修正して確認。元の失敗原本も保存する。
新focusedはserializer一回/parse一回、全nested拒否/許可、サイズ/所在地、元partial/exit、token/UID/cwd差替え、
出力失敗、helper読戻し不一致、同期再入、private reason、実2wireを対象とする。旧成功群は再走しない。

専有fixtureでframeが保存されてもkind=fixture_core、binding unknown/reporting/resource false。
ordinary helperはtrusted adapter無しならexpected_pins_provenance_missingでunknown停止。
実host/cron/自然job/私有保存先作成、実core CLI有効化、Node/npm/NVM/resource/HTTP/ref/配布は0。
次はsourceの独立採否と、Fr/Emmaのwholepins既信頼・通常PRCI/main・実方式gateである。
# Begin runtime alias repair

GPT-CORE-RUN-ALIAS-1: begin previously passed its validated private runtime object directly to the injected bridge. The bridge could change entry_path before the result was frozen. Begin now freezes the private validated snapshot immediately and passes a structured clone across the bridge boundary. Post-await own-runtime and kernel checks still use the private original. New focused tests cover a bridge mutation and the normal begin control, without rerunning the original 13 tests.

