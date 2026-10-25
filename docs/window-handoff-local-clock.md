# raw UTCとprivate monotonic budgetのclock候補

30f0eb7の補正epoch版は単体11件の原本をGit/保存rawlogに保持する。ただしそのnow()+budgetを
Unix-msとしてWaitへ渡す結合は不適切だったため、現sourceから補正epoch APIを除く。
旧unit testは保存原本へ退避し、現在の契約には新focusedだけを使う。

## 時計と予算の意味

now()は生のUnix UTC msだけを返す。createSystemLocalClientClockは明示construction時に
Date.now/performance.now/setTimeout/clearTimeoutの参照を取得する。module importでは採取/timer生成0。
API取得と単調期限計算/解除は当席、同認証channelのWait配送/queueとproviderはWindows所有。

startRequest(originalRawAbsolute)で最初のUTC残量を単調deadlineへ一回固定する。
同じprivate tokenをbegin/current/capture/bindの全runで保持し、RPC完了/UTC rollbackで再発行しない。
startCleanup(budgetMs)は元abort/元tokenと独立し、開始時raw UTC absoluteと単調deadlineを一回固定。
opaque tokenは発行clockのWeakMapだけで有効。別clock/複写/JSON自己申告で作れない。

remaining(token)はraw absoluteとfloor(min(元mono残量, 元raw absolute - 現raw UTC))を返す。
request上限120000ms、cleanup上限30000ms。残量1ms未満/尽きでは新exchange/writeを開始しない。
ceilや最低1ms切上げで予算を再作成しない。forwardはraw期限でも拒否し、rollbackはmono期限で拒否する。
atBudgetは同tokenのtimerを登録し、終了/取消でtimer/callback/ticketを外す。

## Wait境界

Waitはraw absoluteDeadlineとmaximumWaitMsとpurpose。JSON内の元deadlineは変更しない。
clientは同token残量を実exchange直前・reply後・最終採用直前で検査する。
cleanupは元signalを含まない。一回のcleanup Promise予約/期限を再入でも共有する60c修理を保持。

Windowsとの合意ではsender queue→write経過もmonoで差し引く。receiverは最初のheader byte時点の
raw UTC/monoを保持し、min(maximumWaitMs, max(0, rawAbsolute - rawNow))を固定monoへ写す。
分割headerのread時間を予算へ加算しない。capはreceiver開始後の待ち上限であり、未測定transitを
正確に引いた/両peer同時終端とは主張しない。clientは自分の元tokenで有限決着/closeする。

配送はWindows所有の別frameVersion2固定21byte案。purposeを含むheader/bodyの対応を固定refで
照合する。旧20byte未実装案は撤回、v1 fallback/混在なし。四RPC JSON/第5RPCの追加0。
このTypeScript Wait型だけを受信保証や実framing成功と数えない。

## 新原結果

同じactual-source probeを固定30f before checkoutと新sourceへ適用する。
通常/RPC間rollback/cleanup中rollback/forwardの4条件はbefore2fail2pass→after4pass。
旧remaining6251/5250を新cap250以内へ抑え、forwardではowner ACKを成功採用しない。
別の新6budget focusedで生UTC/private token/RPC間期限/独立cleanup/端数floor/範囲/破棄を確認する。
旧13/9/11/4は再走しない。既13/4のfixture driverだけ新clock型へ適合し、期待を変えない。

OS時刻変更/実IPC/OS/FOX/CDP/API/通知0。system factory実時間検証0。
新sourceとfake receiver計算の結合結果であり、実Windows provider/実Wait配送/時間精度の受入ではない。
