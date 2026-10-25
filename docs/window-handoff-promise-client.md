# Promise clientとWindows transport portの責務案

未公開source候補。af14 logical adapterと13f0656 codec/receipt mapを再利用する。
通常CLI/index、実pipe/handshake/frame、FOX/OS/CDP/通知へは結線しない。
正確origin https://github.com/quolu/OL-RemoteWindow.git 、
codex/window-handoff-contract@da359c9e61900d95d9619f9e7242682c0ccb1362の
WindowHandoffLocalSessionPort.cs/docに合わせたTypeScript宣言である。

## transport port案

`src/window-handoff-session-port.ts`の`LocalAuthenticatedChannel`は、
Windows発行opaque session・最初のhostRegistrationId・session.closedを持つ。
全callは同一channel/namespaceだけで実行する。reconnect/再送はない。

```ts
subscribeControl(receive) // -> { lost: AbortSignal, dispose() }
exchange(bytes, { purpose: "request", absoluteDeadline, maximumWaitMs, originalAbort? }
              | { purpose: "cleanup", absoluteDeadline, maximumWaitMs })
  // -> { kind: "reply", session, bytes, watchLifetime? }
  //  | { kind: "failure", reason, delivery: "not_sent" | "unknown" }
close() // -> Promise<void>; 回収ACKとは別
```

四RPC/4096B/既存JSONは変更しない。目的とtransport期限はJSON fieldへ追加しない。
not_sentは当該write開始前の根拠がある場合だけ。begin不存在やowner回収確定ではない。
throw/送信成否不明はunknown。reply受領、業務成功、cleanup確定は別の状態である。
cancelは元beginCallIdまたは原tupleへ到達し、新beginで照会しない。

SubscribeControlはconstructor内でbegin write前に購読し、同じleaseと元Lost signalを
保持する。Windowsと同じtyped controlは元session/beginCallId/原tuple/固定reasonへ相関する。
armed前lossも元callへ保持し、後着tupleと再照合する。別session/未知call/別tuple/未知control、
購読喪失はsessionを封じる。これは第5RPCや通知frameの先行実装ではない。

ReceivedのwatchLifetimeはarmedだけに付ける。元session/beginCallId/原tuple/Invalidated/
Lossをsnapshotし、初回replyと完全一致させる。clientはそのnative由来Invalidated signalを
そのままwatchへ渡し、watch用AbortControllerを作らない。client内部のseal controllerは
待ちを打ち切るためだけで、watch/監視成功の証拠として返さない。

実portは購読前後に空白なくlossを運び、元native監視の失効を先に確定する責務を持つ。
通知より先にHost/worker scopeを止め、EOF/購読喪失時には全lifetimeを失効させる。
型/Promise/fixture tokenだけではその証明にならない。宣言型はWindows portと一対一に
対応するが、実frame/handshake/pipe/認可/監視の実装は含めない。

requestは既codecが作るimmutable stringなのでcallerのbyte buffer aliasを受けない。
future Windows portはUTF8要求bytesを呼出し時に所有copyする。clientもreply受領時に
session/bytes/lifetime/tupleを次のawait前にsnapshotし、元buffer/tuple変更へ追随しない。

## Promise決着とcleanup

`PromiseWindowHandoffClient`は`WindowHandoffInputPorts`を実装する。
begin/current/boundは既mapで元session/call/receiptと相関し、captureだけは外から注入する。
実CDPは呼ばない。元request signal/元絶対期限はそのまま通常exchangeへ渡す。
注入clockの絶対timer、元signal、session/購読/watch失効でPromiseを有限に決着させる。
clock実装は開始時残時間を単調時計へ固定しUTC後退で延長せず、UTC期限超過も拒否する責務を持つ。
actual I/O終了と期限遵守はWindows channelにも必要であり、clientのraceだけでnative停止を
証明しない。遅いoperation completionは新しい成功採用へ進まない。

begin応答が無い/不正/元要求abort/期限切れなら、begin port自身が元callの取消を行う。
受領済みwatchの異常はaf14がcancelWatchへ渡す。known watchの重複cancelは同じPromiseへ
まとめ、一つの元tupleと一つのcleanup期限で処理する。共有Promiseの予約をclock/transport等の
外部処理より先に行う。native失効listenerから同期的に再入しても、元予約を返し二つ目の
cleanup/RPC/予算を作らない。ACKの二重受理無視やowner idempotenceには依存しない。

cleanupBudgetMsは候補の明示引数（正safe整数、上限30秒）。cleanup開始時刻+budgetを
一回固定し、元要求/監視signalはcancelへ渡さない。session.closed/sealは送達不能として残す。元期限後も同channelで取消できる。応答待ち/再照会で期限を延長しない。
exact cancelled ACKを新cleanup期限内に採用した時だけconfirmed。ACK不明/期限後/EOFは
unknownと固定安全errorとしてsessionをcloseする。closeのpending/completed/failedを別記録し、完了を回収ACKへ変換しない。EOFはsession sealと全watch失効でありowner回収ACKではない。
sessionが閉じた後に別sessionからcleanupしない。native allocation group/遅い作成の回収は
Windows owner側に残り、clientに通知が届かなくても継続する。

`cleanupState`（not_started/unknown/confirmed）と`beginTransportState`
（not_called/not_sent/unknown/reply_received）は別々に返す。not_sent/noneをcleanup成功へ
置換しない。元ownerのunknown後にexact取消ACKが得られればcleanupはconfirmedとなるが、
begin自体は失敗のまま。任意transport例外本文は外へ出さない。

## 新しい結合fixture

新13件のみ実行する。偽channel/clock/native signalで、af14からPromise clientを通す。
正常同寿命、begin前取消/購読喪失、not_sent/unknown/応答喪失、abort後遅いarmed、
期限後の原tuple取消、EOF、取消ACK不明/有限deadline、armed前loss/購読喪失、
不正session/replyとcleanup未確認、mutable handle/重複cancel、未知/旧control、
旧世代lifetime、受領bytes/lifetime変更のsnapshotを確認する。
旧9/旧11/Windows135/Appleのgreen群は再走しない。
Windowsのlocal-session-order-cases.jsonはexecuted=falseの原候補として保持する。
当席13件の結果だけが実行済みで、owner factory/OS回収など未実装の期待まで合格へしない。

3303fdfで見つかったcancel同期再入P2は、上記の予約順で修理する。追加のfocused4件だけを
before4fail→after4passで確認する。direct/native失効listenerからの同期再入×取消confirmed/unknownで、
同Promise/原reference/一RPC/固定cleanup期限を確認。旧13/9/11は再走しない。

当席は元signal/receipt/call/Promise/有限cleanupと注入captureの接続を持つ。
Windowsは相互認証session発行・初回登録・同接続RPC・EOF/watch-loss・監視投影・
native owner cleanupを持つ。clock portの実実装/実frame/handshakeの採用も別工程。
この候補とfixtureはsource合成だけであり、現FOX反映やOwnerへ渡せる実入口ではない。


## clock/Wait結合P2の追加修理

30f補正epochを生Unix deadlineへ渡さず、raw UTC/private mono token/maximumWaitMsを分離する。
requestは元JSON期限と最初のtokenを全RPCで維持。cleanupは一回の別token/raw期限を持つ。
最大request120000/cleanup30000、残量floor/1ms未満exchange0。元signalをCleanupWaitへ持ち込まない。
実exchange直前/reply後/最終採用前に同tokenを確認する。clock/token APIは独立原本時刻の代用ではない。
receiver有限cap・sender queue経過控除・frameVersion2の実配送はWindows所有の別受入。
詳細window-handoff-local-clock.md。旧30fの11単体結果を新結合成功へ昇格しない。
