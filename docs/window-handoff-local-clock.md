# LocalClientClockの独立実装候補

60c6555のcancel同期再入P2はヘンゼル独立受入済み。旧Promise/codec/成功群は変更・再走しない。
本候補は`src/window-handoff-local-clock.ts`だけのclock実装と新focused検査で、CLI/実channelへimportしない。

`createSystemLocalClientClock()`を明示的に呼んだ時だけ、NodeのDate.now、
node:perf_hooksのperformance.now、setTimeout/clearTimeoutの関数参照を取得する。
実際の期限計算/登録/解除は当席clock provider、RPC/native回収はWindows portの責務。
module importでは時刻採取やtimer生成を行わない。

at(UTC期限, callback)は登録の先頭でperformance時計→UTC時計の順に一回取得し、
そのUTC残時間を元の単調期限へ固定する。UTC取得中の時間を新しい待ちへ加算しない。
UTC後退、now読取やread進捗、早いtimer再発火で単調期限を再設定しない。
timer再登録が必要なら固定単調期限/元UTC期限の残りだけを使う。Node timer上限も越えない。

now()は期限判定専用のepoch値を返す。最初のUTC/単調時計の組から経過時間を保ち、
実UTCが先へ進んだ時だけepochを上げる。raw観測UTCではなく、観測原本の日時に使用しない。
一つのRPCが終わり登録を解除した後でも、rollback後の次のRPCに元期限の予算を再発行しない。
now()は実UTCまたは単調期限が到達した登録を終了させてから期限epochを返す。
UTC先行はtimer wakeでも確認し、late replyの採用前に元期限を拒否する。
timerはUTC変更通知を持たないため、先行を検知する時点は次のnow読取またはtimer wake。
即時のOS時刻変更イベント検出を主張せず、Promise採用前のnow検査を省略しない。

返すcancel関数がその登録の取消/破棄handle。複数回呼んでも同じ登録だけを解除する。
timer/token/closureを外部callback実行前に外し、古いtimerの二重発火をticketで拒否する。
発火前にcancelした登録を復活させず、同期timer callbackでhandle発行順が逆になっても残さない。
購読がある間だけproviderが登録を保持する。clock全体のdisposeで生きたPromiseを黙って放棄するAPIは設けない。
channel/clientのabort/決着時にatの返すcancelを呼ぶ既bounded責務を使う。

新11件は注入UTC/performance/timerだけで検査した。UTC rollbackと反復read、RPC間rollback、早いwake/古callback、
UTC forward（read/wake）、取消/登録破棄、既期限切れ、callback再入、期限直前の取消競合、
同期timer発火、長期timer上限、forward後のPromise begin拒否と別cleanupを確認する。
初回はfakeが早くcallbackを渡した時のhandle未解除1件を保存。受信callbackでも元timerを解除する修理を入れ、
同じ条件を含む新11件のfinal原本だけを成功根拠にする。期待を緩めず、旧13/9/11/4は再走しない。

これは実計算コードをfake sourceで通した結果。OS時計変更0、実Node timer/performanceによる時間精度/待ち時間の受入0、
実pipe/CDP/FOX/API/通知/CLI結線0。実時間adapter受入とWindows framing/handshake/control codecは別工程。
