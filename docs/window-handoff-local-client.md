# Local v1値codec・最初のreceiptの保持

source-only候補。通常CLI、公開entry、現在のFOX/Hostへimportしない。

正確な共有originは https://github.com/quolu/OL-RemoteWindow.git 、branch
`codex/window-handoff-contract`、固定commit
`e3c7acd23a79d737241785788e7e32aa61d78e21`。
`docs/window-handoff-local-codec.md`とWindows値codec/owner registryに対応する。
`kitepon/OL-RemoteWindow`という旧通知の表記は採用しない。

共有fixture `tests/windows/WindowHandoffProbe/testdata/local-synthetic.json`を
`test/fixtures/window-handoff-local-synthetic.json`へ同byteでコピーした。
4490 bytes、SHA256 `7567222655ff65ee3db7b310bd4ebdb2340ecdbb92fe8e3118ecb51e1cba7b6c`。
Windows所有の原fixtureは変更しない。

## 値codec

`src/window-handoff-local-codec.ts`は四requestと五outcomeのexact keyを検証する。
UTF8/4096 bytes/depth8、正safe整数、PID/session UInt32、HWND UInt64 decimal文字列、
SID構文、Host登録Idを検査する。JSON.parse前の字句検査で重複key（escape同値も）、
指数/小数/bool/null/余分/欠測を拒否する。固定errorだけを返す。

createdAtは秒または1〜7小数桁のUTC原文字列を保持する。有効calendarと正FILETIME範囲を
検査するが、FILETIME numberは生成しない。Date.toISOStringによる3桁再発行も行わない。
年月日の検証にDateを使う部分はcalendarだけで、100ns部分のidentity比較には使わない。

## af14 logical portとの対応

| logical port | source候補の責務 |
| --- | --- |
| beginWatch | begin前にopaque session/登録Id/元callId/hint/期限/元signalを固定。armedのcall/outcome/登録/同hint/期限を検査し最初のtupleをprivateに保存 |
| assertCurrent | 元watch objectのWeakMapから原tupleと元期限を取得。currentがそのtupleと完全一致する場合だけ採用 |
| capture | local CDP側に残す。JSON kindへ増設しない |
| bindTarget | 同identityとarmed後の新観測を元tupleへ束縛。boundを同tuple/元期限で採用 |
| cancelWatch | objectから最初のtupleを取得しmode watchへ。public fieldsは再読しない。元期限後/abort後も取消可 |
| begin未受領 | 元begin handleからmode begin/元beginCallId/元session登録Idへ取消。新beginを照会の代わりに発行しない |

`src/window-handoff-local-receipts.ts`の`LocalHandoffReceiptMap`は送受信前後の純粋な
値相関候補である。`LocalPendingCall.bytes`を作り、明示的な`accept(session, call, bytes, watchSignal)`
で確認する。自分でtransportを呼ばず、Promise portとしてaf14へまだ結線しない。
begin→watchArmed→新capture→bindの順序の所有者はaf14のままである。

opaque session objectは将来の相互認証IPCが与える必要がある。同objectには一個のmapだけを
作りcallId namespaceを一つに固定する。このconstructor/JSONの登録IdやSIDは実認証ではない。
実transportは当該sessionの接続だけで送受信する責務を持つ。

初回receiptはprivateなimmutable tupleへ保存し、public watchを変更しても取消先は変わらない。
元request signalと、将来の監視/IPCが与えるwatch signalは元object参照を保持しJSONへ載せない。
未知のbegin、parse失敗、transport未達、error.effect=noneだけで回収確定へ昇格しない。
exact cancelled ACKのみconfirmedとなる。confirmedは後発unknownで戻さない。
取消intent後/元期限後/EOF後のarmedを採用せず、unknownのまま新beginへ代替しない。

## 新pure検査と実未成立

新9件のみ：共有fixture全request/replyのroundtrip、厳密JSON/範囲、7桁時刻/UInt64、
正常begin/current/bound/cancel、mutable watch原tuple、unknown beginの元call取消、
session/call/outcome/tuple相関、遅いarmed/期限/EOFと回収単調性、元signal/監視失効。
既af14/4727の11件、Windows135件、Apple検査は再走しない。

実IPC認可/handshake、OS寿命anchor、timeout/pipe終了、native allocation groupの実回収、
CDP capture、実signal発行、FOX導入/Hook/property、API/通知/Owner受入/映像入力は未実装。
EOF後のnative回収はWindows owner側に残り、map.closeを回収成功と数えない。
純粋なACK値を実resource破棄や実認証の証明にしない。実入口/使えるURLはまだ成立しない。
