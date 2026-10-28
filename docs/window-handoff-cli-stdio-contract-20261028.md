# Window handoff CLI stdio契約案 v1

2026-10-28。**文書設計候補。方式選定・実装開始・native受入の合意ではない。**
基準はGPT `3f1fe6ae50658bfb92637431ad47283e990728d9`の[SessionPort](../src/window-handoff-session-port.ts)、[Promise client](../src/window-handoff-promise-client.ts)、[codec](../src/window-handoff-local-codec.ts)、[receipt map](../src/window-handoff-local-receipts.ts)と、Windows `quolu/OL-RemoteWindow@1db7121acc2c8f6224b7fa926b530c707d934d62`のbootstrap提案/LocalSessionAdapter/LocalSessionPort/NativeBinding。

## 1. 一つだけ使う経路

`prepareOwnedWindowHandoff → PromiseWindowHandoffClient → stdio SessionPort proxy → 外部独立CLI --window-handoff-local-v1 → Windows LocalSessionAdapter/Provider → 既存GUI`。
WindowsだけがGUI data-pipeのhandshake/read pump/v2 parserを持つ。この経路でTS FramedLocalAuthenticatedChannelを生成しない。四RPCのcallIdはTS receipt mapだけが発行する。CLIは元body bytesを再serialize・再採番しない。両端の既codec/tuple検査は残す。

一つの固定導入済みexeの元child/stdioに、一回のopen、一つのsession、一つの元bootstrap予約を束縛する。親は元ChildProcessと全stdio/exit、Windowsは元HANDLE/予約/native監視を所有する。親のPID/stdioや下記readyをOS trust rootにはしない。GUIがなければoffline。GUI/serviceの起動・別exe探索・再spawn/再接続・自動再送で補わない。HANDLE/context/pipe名・秘密・raw例外をstdio/public errorへ出さない。

## 2. 共通符号化と型

各recordは`uint32 little-endian payloadByteLength`の4byteと、その長さのstrict UTF8 JSON object。payloadは**1..16384 byte**、headerを含めない。4096Bの原bodyのbase64（最大5464文字）と有界tuple/snapshotを一recordへ入れる上限を16KiBに固定する。大小端/長さ/文字コードの推測・自動検出・改行区切りへのfallbackはしない。

全objectは下記のexact key集合のみ。optionalと書いていないkeyは必須、nullを省略しない。key順は不問。decode後に同じkeyとなる重複（Unicode escapeを含む）をJSON.parse前に拒否する。未知key/enum・不足key・不正UTF8/BOM・不正escape/孤立surrogate・trailing byte・複数JSON値を拒否する。数値tokenは`0|[1-9][0-9]*`のみ、整数・上限を丸めず検査する。負数/-0/小数/exponent、NaN/Infinity、文字列から数への変換は禁止。object/arrayの代替型や自動defaultはない。record全体を検証してから副作用へ進む。

| 型 | exact値域 |
| --- | --- |
| V | 数値1 |
| Id / Epoch | 数値1..9007199254740991。Idは原四RPCのcallId/beginCallId、Epochはraw UTC Unix ms |
| Cap | 四RPC requestは数値1..120000、cleanupは1..30000。openには下記OpenWaitの狭い上限を使う |
| Registration | 文字列`[a-f0-9]{32}` |
| Body | canonical RFC4648 standard base64、padding必須となる場合は`=`を含む。空白/URL alphabet/非zero pad bitを拒否し、decode→encode一致を要求。decode後1..4096Bの原strict UTF8四RPC JSON。原byteを保持 |
| Delivery | `not_sent` / `unknown`。今回のexchangeのGUI向けwriteだけを表す |
| TransportReason | `offline` / `request_aborted` / `deadline_expired` / `peer_eof` / `io_failed` / `protocol_invalid` / `session_closed` |
| OpenReason | `offline` / `busy` / `unsupported` / `deadline_expired` / `request_aborted` / `root_unknown` / `invalid_input` / `protocol_invalid` / `io_failed` / `peer_eof` / `session_closed` |
| Loss | `window_destroyed` / `process_exited` / `anchor_lost` / `monitor_lost` / `registration_changed` / `deadline_expired` / `session_closed` |
| Wait | `{purpose,absoluteDeadline,maximumWaitMs}`。purposeは`request`か`cleanup`、期限はEpoch、残量はCap。purposeに応じた上限を適用 |
| OpenWait | `{purpose,absoluteDeadline,maximumWaitMs}`。purpose=`request`、期限はEpoch、残量は数値**1..2000**。Windows固定1dbのNativeBinding.cs:91と同じ上限 |
| Identity | `{pid,createdAt,ownerSid,sessionId,hwnd}`。pid/sessionIdは数値1..4294967295、ownerSidは最大256 UTF16 code unitの`S-[0-9]+(-[0-9]+)+`。hwndは先頭zeroなしの正整数文字列、最大18446744073709551615 |
| createdAt | codecと同じ実在暦のUTC `YYYY-MM-DDTHH:mm:ss[.1..7桁]Z`、年1601..9999、FILETIME zeroより後、うるう秒なし。元文字列を保持 |
| Tuple | `{watchId,hostRegistrationId,expiresAt,identity}`。watchIdは1..128 UTF16 code unit、登録はRegistration、期限はEpoch、identityはIdentity。codecと完全一致、同値への正規化・再発行なし |
| Snapshot | `{beginCallId,originalTuple,invalidated,loss}`。Id/Tuple/boolean/(Loss又はnull)。invalidated=falseならloss=null。true/nullを許す。loss!=nullならtrue必須 |

Idは元child session内で再利用しない。envelopeに新しい相関ID/session tokenを足さず、元child IOの所有をsession識別に使う。原RPC body内のversion=1/callId/kind/outcome/referenceとWaitの対応は既codec/receipt契約のまま検査する。元bodyを読んでの検査は許すが、搬送bodyを書き直さない。

新envelopeはboolean/nullも使うため、正整数/string/objectだけを読む既decodeLocalJsonValueをそのまま流用しない。専用envelope検証と、元bodyに対する既codecの検証を分ける。GUI data-pipeのparser/readは増やさない。

## 3. 親→CLIのexact record

以下の`{...}`は型指定であり、括弧内のkeyが全key。全recordにVの`v`と固定文字列`kind`が必須。

| kind | exact keyと型 / 条件 |
| --- | --- |
| open | `{v,kind,wait}`。OpenWait。最初のrecord、一回だけ。四RPC requestの120000上限へ緩和しない |
| exchange | `{v,kind,callId,body,wait}`。Id/Body/Wait。ready後のみ。envelope callId=body.callId。begin/current/bindはrequest、cancel_watchだけcleanup。request body deadline=wait.absoluteDeadline、cancelの期限は元requestを使わずcleanup期限 |
| abort | `{v,kind,scope}`（scope=`open`）又は`{v,kind,scope,callId}`（scope=`call`、Id）。他の組合せを拒否 |
| close | `{v,kind,wait}`。Wait.purpose=cleanup。元close観測予算を一回渡す。再closeを送らず、親の同じPromiseへまとめる |

openより前のabort/close、未readyのexchangeは不正。open取消/失敗後もcloseは許す。close後の新exchange/openは禁止。abort(open)は元openにだけ作用し、ready公開との先着を元gateで確定する。公開が先なら後着abortで新bootstrap取消を発行せず、元移譲先の既guardへ従う。abort(call)は既受理した原requestの元tokenだけを取消し、cleanup tokenには作用しない。未受理Id/cleanup用Idは不正、既決着Idへの遅いabortは同元tokenへのno-op。原callへ最初に到達したabortだけを保存する。

abortには返答record/新callIdがなく、四RPCのcancel_watchを発行する操作ではない。親はexchange envelopeの完全write前にabort recordを割り込ませない。未writeの元queueを除外できれば送らずnot_sent、write開始後の取消は同元callを保持してUnknownにも備える。CLIの唯一のstdin readerはExchangeAsync完了をawaitして停止せず、受理台帳→非同期完了へ分けてabort/独立cleanup/closeを配送する。各原bodyは一回だけExchangeAsyncへ渡す。

exchangeは元callIdの増加順でwrite位置を予約し、childも同順序/再利用なしを検査する。未送信Idによる欠番は許す。親write前のnot_sentでchildが元beginを一度も受理しなかった場合も、後のcancel_watchから架空begin/回収ACKを作らない。既portが原referenceを確認できなければcleanup=unknownを保持する。

## 4. CLI→親のexact record

| kind | exact keyと型 / 条件 |
| --- | --- |
| ready | `{v,kind,hostRegistrationId}`。Registration。一回だけ。失敗openからの再ready禁止 |
| open_failed | `{v,kind,reason,effect}`。OpenReason、effect=`none`又は`unknown`。元bootstrapの効果の有無。GUIへの四RPC deliveryやwindow回収ACKとは別 |
| reply | `{v,kind,callId,body,lifetime}`。Id/Body/(Snapshot又はnull)。body.callId一致。armed replyだけ非null、他のoutcomeはnull |
| failed | `{v,kind,callId,reason,delivery}`。Id/TransportReason/Delivery。既HandoffLocalExchangeFailedと一対一。業務error replyをfailedへ書き換えない |
| watch_invalidated | `{v,kind,snapshot}`。Snapshot.invalidated=true。同元beginの購読からのみ。loss=nullも許す |
| session_ended | `{v,kind,reason}`。TransportReason。ready後に一回。全元lifetimeを失効させるが物理process終了は認定しない |
| terminal | `{v,kind,state,pending,failure}`。state=`closed`又は`unconfirmed`、pending=boolean、failure=OpenReason又はnull。下記の終端規則を適用 |

readyとopen_failedは排他。readyは、Windows既native bootstrap/binding admission・完全ReadyAck・SessionAdapter初期化・CLIのcontrol購読設置が終わった後だけ。親は全readyを検証した後に元child IOへ一つのJS session object/登録/closed signal/control購読を束縛し、初回exchange前にTS Promise clientへ供給する。親の未準備期間に来たrecordは同readerが順序を保持し、session_endedを落としてreadyだけを渡さない。

terminalはready又はopen_failedの後だけ。opening中にclose/abortが先着した場合も、正常に受理した元openの失敗を一回出してから有限terminalへ進む。原openをまだ受理していないpre-openではopen_failed/terminalを作らず、§8の無record終端に従う。watch_invalidatedはready後/既受理beginのみ。子の出力順序を、親が受信後に都合よく並べ替えない。

open_failed.effect=noneはWindows側が原要求未開始又は効果なしを確定できた時だけ。GUIなしoffline/busyの確定negativeも本人照合を通した根拠が必要。不明なroot・partial RPC・失われた応答でnoneを作らない。open_failed後はreply/readyなし、元bootstrap cleanup/drainのterminalは別に続く。

各exchangeにreply又はfailedを最大一つ、受理順とは独立に原callIdで対応づける。未受理Id/重複決着/別tuple・別登録・新規採番・ready前replyはprotocol_invalid。親が有限待ちを終えた原callも台帳から即削除せず、遅い元結果をdrain/記録する。遅い結果から元callを成功へ再決着せず、新しいcallへ転用しない。原cancelのexact cancelled ACKだけを既cleanup token内で受理できる。effect=noneのerror、failed、terminal、EOFを同ACKへ代用しない。

armedのSnapshot.beginCallId=reply.callId=原begin callId、Snapshot.originalTuple=body.watch、Tuple登録=ready登録、HWND=原hint、expiresAt<=原begin.deadlineを必須とする。watch_invalidatedも既受理の元begin/同登録/同hint/元期限に束縛する。session_ended後は新ready/reply/active snapshotを公開せず、未決着原callのfailedとterminalだけを出す。既に決着した原結果の遅いnative完了は子でdrainする。

## 5. snapshotと順序付きnative lifetime投影

Windows側の元owner停止→native失効→通知が前提。CLIは元SessionPortのnative lifetimeとcontrolを保持し、`(元session,beginCallId,完全Tuple)`ごとに購読・初期snapshot・出力queueの順序を一つの元gateで束縛する。snapshotとreplyの出力位置を同じgateで予約し、購読前後の失効を落とさない。原callback/controlの同期再入も同じ元台帳へ記録する。元Task/HANDLE/CancellationTokenをprocess間で同じobjectとして移送したと主張しない。

初回armedのlifetimeは元native Snapshot。購読設定ができない/元lifetimeとの結合が不明ならactive armedを公開せず、replyを捏造せずsessionを失敗させる。watch_invalidatedはarmedより先でも同元beginとTupleへ保持する。初期snapshotと後続eventを合わせ、false→true、loss=null→最初の非nullの遷移だけを許す。true→false、非null lossの変更・削除を拒否する。同じ状態の重複をCLIがcoalesceし、二重recordを出さない。

親proxyは一つのreadonly signalを保持し、Tupleは完全snapshot、元byte/bodyから同値性を検証する。先着失効は後着armedで復活させない。Invalidated=true/初期Lossありならarmedをactiveに採用せず、既Promise clientの原begin cleanupへ進む。

- loss=nullの失効は元local intent等を表し得る。signalを失効させるが、OSのloss理由を作ってtyped watch_lostへ変えない。
- 非null Lossは元signalを先に失効させてから、既LocalControl.watch_lostへ同begin/Tuple/理由を渡す。先着Lossを保持し、別理由へ差し替えない。
- 元control購読喪失、EOF、session_ended、protocol invalidは全proxyを不可逆に失効。これは通信/購読の終了であり、ProcessExited/Reclaimedを意味しない。既に記録したnative Lossは保持する。

親が作るAbortSignalは元native監視の**投影**であり、新しい監視発行や認証成功ではない。この新cross-process投影契約と元購読の結合はWindows側の具体schema/source・独立受入が必要で、既3fのsame-process signal注入の受入を代用しない。

## 6. 元予算・NotSent/Unknown・独立cleanup

親はspawn前のopen token、begin→assert→capture→bindで共用する元request token、一回のcancel_watch tokenを別々に保持する。原raw deadlineと当該tokenの残量capだけを送る。親queue→stdio実write境界で再採用せず残量をfloor、1ms未満は送らない。CLIは受信cap/raw期限から同process tokenを一回作り、その後のqueue→native writeでも短縮だけする。受信Monoを送信Monoと同一にしない。transport滞在時間を正確に計測したとも主張しない。

openは親の最初のcapから**最大2000ms**。spawn/queue/最初のbootstrapからbinding admissionまで、その元open budgetを短縮だけして一回採用する。binding到達時にも2000msを新たに与えず、新now+budget/新tokenへ戻さない。現Windows Buildの新規budget作成をそのまま使って採用済みとは扱わず、元budgetを渡すprivate接点はWindowsの具体化対象に残す。openと後続四RPCは別予算。同一offerの共通上限を加える時は元上限tokenを一回採用する接点を別途固定し、既TS beginWatchの新token作成だけで引継済みにしない。close.waitは元teardownの有限**観測**上限を一回固定したもの。受理/再照会でnative ownerの既cleanup予算を再発行・延長しない。

Delivery.not_sentを親が確定できるのは、元envelopeを実writeしていない所有queueから除外できた場合、又は同childのWindows adapterが当該GUI向けwrite開始前と確定したfailedを親が完全受領した場合だけ。stdio.writeのcallback/完全envelope送信はGUI向けwriteの証明ではない。partial IO、返答喪失、child exit、実write以降に送信状況が不明ならunknown。元begin存在・効果なし・回収済みをnot_sentから導かない。

四RPC取消は既TS Promise cleanupだけが元beginCallId又は元Tupleを使って発行する。request abort/元期限/失効signalをcleanupへ継承せず、一回の独立tokenを使う。CLIは代理cancel_watch/第五RPC/新cleanup期限を作らない。bootstrap CancelOriginal/ReturnReservationはWindowsの元OpenCallId/receiptへ別に束縛する。session封鎖後は別sessionから取消を行わず、native ownerが遅い作成・回収を持ち続ける。close.waitやterminalはcancel_watchの確認を進めない。

## 7. 有限未確認と元childの終端

close又は元IO喪失は先にsessionを封じ、新admissionを止める。未決着call/元stream/元native call/late out HANDLE/購読callbackを所有する元Taskは残す。親の有限待ちが切れてもchild kill・参照破棄・別childへの移行で処理済みにしない。

terminal.closedはpending=false/failure=nullのみ。WindowsのAdapterDrain、bindingDrain、bootstrapのlate RPC/out HANDLE、scope購読retire/callback drain等が元所有者の根拠で終端し、保存失敗もなく、先行stdout recordが全write済みの場合だけ出す。単なるCloseAsync/closeEnd完了を根拠にしない。CLI自身のterminal write/stream close/exitはこの後に続くため、親が別途観測する。

観測期限までに上記証拠が揃わなければterminal.unconfirmed。pending=trueは元Task/IO等が未終端、pending=falseは終端したが保存失敗により肯定できない場合で、この場合failure!=null。pending=trueならfailureは最初の固定失敗又はnull。failureは一度非nullになれば変更/削除しない。最初の有限待ち切れ自体をnative失敗と捏造しない。

同元childが遅く終端した時に限り、pending=trueのunconfirmedの後へ一つの最終terminal（pending=false）を出せる。未確認snapshotの反復、最終terminalの重複、その後のrecordは不可。失敗がなければ後着closed、保存失敗があればunconfirmed/failureを保持。親の既返却済み失敗・過去の未確認を成功へ書き換えない。

親のlifecycle.closedには、最終terminal.closedの完全受領に加え、元stdinの終了、stdout/stderrのEOF、元child exit(code=0、signalなし)と全所有IO終端が必要。exit0だけ・EOFだけ・terminalだけでは未確認。stderrはdrainするが任意本文をpublic error/診断原本へ転載しない。unconfirmed/pending=trueのchildは元ownerがdrainを継続し、CLIが先に終了して所有参照を捨てない。IO/exitが失われれば親も元監督参照を保持してunconfirmedとする。

## 8. partial EOFとprotocol failure

headerの1..3byte又はpayload途中でのEOFはprotocol_invalid、未決着deliveryはunknown。header/payloadの長さが不正なら追加確保/実処理前に拒否。0byte境界EOFでも完全な最終terminal.closedがなければpeer_eof/未確認。原記録済みの原因を後着EOF/exitで置換しない。complete frame受信後に到来した遅い終端はその元callだけへ相関する。

stdinのpartial/不正入力を子が検出した時は入力処理を止め、元所有者が持つ停止/drainへ進む。stdoutが生きている場合の出力は次表だけ。phaseは、元gateで正常openの受理又はready/open_failedの出力位置を確定した状態で決める。queued readyを後から撤回してopeningへ戻さず、元writer順を保つ。

表のprotocol_invalidはstdin不正が最初の原因の場合。元token失効/abort等の原因が先着して保存済みならその元reasonを維持し、表のrecord順だけを適用する。

| 検出時のphase | exactな出力/終端順 |
| --- | --- |
| pre-open（正常open未受理） | **stdout recordを一切出さない**。bootstrap/native admissionを行わず、元ローカルstdioを閉じexit code=1。存在しない原Openのopen_failed/terminal、ready/session_endedを作らない |
| opening（正常open受理済み、ready/open_failed未確定） | `open_failed {v:1,kind:"open_failed",reason:"protocol_invalid",effect:E}`を一回→§7のterminal。Eは保存した原bootstrap効果の根拠からnone/unknown。受理済みだけではnoneにしない。ready/session_endedなし |
| ready後（session_ended未確定） | `session_ended {v:1,kind:"session_ended",reason:"protocol_invalid"}`を一回→未決着原callのfailed（存在する場合）→§7のterminal。新ready/reply/active snapshotなし |
| open_failed又はsession_ended確定後、最終terminal前 | 同じ失敗recordを再発行せず、保存した最初の原因/効果を維持して残る原failedと§7のterminalだけへ進む |
| 最終terminal確定後 | 新recordなし。入力処理は既に停止しており、元stdio/exitを終端する |

pre-open無record終端を親が観測しても、子のphase/効果なしをexit code=1から推定しない。元open envelopeをwrite開始していればbootstrapEffect=unknown、親がまだwriteしていない元queueを保持していればnot_started。stdoutのframe境界EOFはpeer_eof、partial stdoutはprotocol_invalidとして、四RPC未呼出のdelivery=not_called/cleanup=not_startedを保持する。不存在のsession/取消ACKを作らない。

出力途中のstdout失敗では上表recordの再送をせず、元IO/native drainを保持する。親は異常stdoutを取り直し・byte resync・再parseして救済しない。正規close後の原frame境界EOF/exitとpartial EOFを区別し、不正stdinから新しいcleanup予算を発行しない。

## 9. 親側のpublic安全失敗への固定写像

新stdio adapterのpublic失敗snapshotはexact `{code,reason,callId,delivery,bootstrapEffect,cleanup,lifecycle,loss}`。旧四RPC JSON/既error codeを変更しない。codeは下表、reasonは下表左列と後述の`rpc_error`、callIdはId又はnull、deliveryは既TS begin状態の`not_called|not_sent|unknown|reply_received`、bootstrapEffectは`not_started|none|unknown|session_ready`、cleanupは既TSの`not_started|unknown|confirmed`、lifecycleは`pending|unconfirmed|closed`、lossは最初のLoss又はnull。任意message/path/argv/例外/秘密を加えない。元codeしか返せない既caller向けにもreason等を製品所有の同snapshotへ保持し、失敗の種類を消さない。

deliveryは既TSと同じ値域を使い、callIdが示す元exchangeに対応させる。後続callのdeliveryをbeginTransportState getterから推定しない。callId=nullで四RPC未呼出ならnot_called。

| reason | code | 原因の採用条件 |
| --- | --- | --- |
| offline | HOST_OFFLINE | 本人照合した既存GUIなし等の確定negative。root不明を流用しない |
| busy | HANDOFF_UNSUPPORTED | 認証済み現在登録/元slotの確定busy。unsupportedとreasonで区別 |
| unsupported | HANDOFF_UNSUPPORTED | 認証済み固定capability/方式が非対応と確定 |
| deadline_expired | HANDOFF_EXPIRED | 元tokenの不可逆失効。新しい期限でやり直さない |
| request_aborted | HANDOFF_UNSUPPORTED | 原request/open abortの先着。独立cleanupをabortしたとは扱わない |
| root_unknown | HANDOFF_UNSUPPORTED | 発行元/登録/元HANDLE等が未確定。offline/非対応/成功と推定しない |
| invalid_input | HANDOFF_INVALID | 元caller入力が送信前の公開契約違反 |
| protocol_invalid | HANDOFF_BINDING_INVALID | 元channel/envelope/相関/tuple/順序の違反。不正入力と方向を区別 |
| io_failed | HANDOFF_UNSUPPORTED | 元IOの固定失敗。任意例外本文なし |
| peer_eof | HANDOFF_UNSUPPORTED | terminal根拠のないchannel/child EOF。物理peer終了とは別 |
| session_closed | HANDOFF_UNSUPPORTED | 元sessionの確定seal。回収成功とは別 |
| watch_invalidated | HANDOFF_BINDING_INVALID | 元snapshot/失効投影で通常処理を採用できない。loss=nullを許す |
| cleanup_unconfirmed | HANDOFF_LOCAL_CLEANUP_UNCONFIRMED | 先行原因なしで、元独立cleanupのexact ACKを確定できない |

上表の確定理由には、元token・送信前検査・typed transport/open結果等、その理由を直接確定する元根拠が必要。TransportReason/OpenReasonは同名reasonへ写像する。open_failedでは四RPCは未呼出なのでdelivery=not_called、cleanup=not_started。bootstrapEffectだけをeffectへ対応させ、その元bootstrap未確認はlifecycleへ別に保持する。

**四RPCの原error replyがcode/effectしか持たない場合は、次の6行だけを適用する。** 原codeをpublic.codeへそのまま保持し、public.reasonは全6codeに対して一意に`rpc_error`とする。これは「同元RPCからこのerror codeを受領した」という理由であり、物理原因/責任/確定capability/先着abort/本人確認negativeを意味しない。新しいreasonは親public候補だけに置き、既四RPC body/envelope replyを変更しない。

| 原reply.code | public.code | public.reason |
| --- | --- | --- |
| HOST_OFFLINE | HOST_OFFLINE | rpc_error |
| HANDOFF_INVALID | HANDOFF_INVALID | rpc_error |
| HANDOFF_EXPIRED | HANDOFF_EXPIRED | rpc_error |
| HANDOFF_BINDING_INVALID | HANDOFF_BINDING_INVALID | rpc_error |
| HANDOFF_UNSUPPORTED | HANDOFF_UNSUPPORTED | rpc_error |
| HANDOFF_LOCAL_CLEANUP_UNCONFIRMED | HANDOFF_LOCAL_CLEANUP_UNCONFIRMED | rpc_error |

ここではdelivery=reply_received、callId=原callId。effectは原replyのまま元四RPC効果の記録へ保持し、bootstrapEffect/cleanup確認へ流用しない。HANDOFF_UNSUPPORTEDからbusy/request_aborted/root_unknown/unsupportedを選ばず、HANDOFF_INVALIDから送信前のinvalid_inputを作らず、HOST_OFFLINEから本人確認済みのGUIなしを作らない。HANDOFF_EXPIREDから親元tokenの失効も推定しない。未知codeはrpc_errorへ丸めずprotocol_invalid。他のoutcomeはerrorへ変換しない。

別に保存済みの元根拠が先着している場合は下記の最初の原因保持に従い、後着code-only replyを二次結果として記録する。code-only replyだけを根拠にrpc_errorを別の確定理由へ後から昇格しない。

code/reason/callIdの最初の原因を、取消/drain/EOFの二次失敗で上書きしない。元原因がある時のcleanup不明はcleanup=unknown、child終端不明はlifecycle=unconfirmedとして元原因に添える。exact cancelled ACKだけがcleanup=confirmedへ進める。cancel失敗のerror/effect=none、bootstrap返却、terminal.closed、exit0は進めない。既に返したsnapshotはimmutable、後着の原結果/終端は別の所有状態に記録し、元失敗や歴史上の未確認を消さない。

## 10. Windowsと照合する未受入境界

この文書が固定するのはenvelopeと親の対応案。Windowsは、元native購読のsnapshot/順序、AdapterDrain/bindingDrain/lateRPC out HANDLE/callbackの元終端と保存失敗、Open budget一回採用、server登録ID/RPC本人照合を具体sourceで対応づける。ready、effect=none、Snapshot、terminalの肯定はその根拠を得た時だけ出す。ncalrpc/MIDL方式・private factory・native投影・実装開始は別の合意/独立受入まで未成立。

今回の成果は文書のみ。CLI実装・compile・新試験・FOX/native/通常接続・main merge/npm公開は実施しない。
