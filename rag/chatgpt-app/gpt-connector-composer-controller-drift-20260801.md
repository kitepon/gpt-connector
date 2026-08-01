# ChatGPT builder composerController drift復旧

- 出典: ログイン済み専用Chromeで読み込まれたChatGPT静的asset（`cdn/assets` core / conversation-small）、gpt-connector 0.4.10/0.4.11ローカル実測
- 取得・実測日: 2026-08-01
- 確度: 高
- 秘密情報: token、cookie、account ID、conversation本文、request bodyは取得・保存していない

## 症状

`doctor`は`ready`（CDP・公式origin・認証・page bridge初期化すべて正常）のまま、chat／consult／画像の
全turnが`CHAT_FAILED: Invalid value used as weak map key`で失敗した。0.4.10でsender検出markerを
修復した直後に発生し、runtime error storeとBugHub factory ingestへ`chat`／`high`として上がった。

## 原因

失敗点はsenderではなくbuilder（conversation chunk）。現行builderは戻り値組み立ての最後に
composer拡張の寄与を合成する。

```js
Ne = r4t(Ne, { clientThreadId: r.id, composerController: n, systemHints: ee })
// r4t: for (let e of ade(t.composerController)) …
// ade → T5t(e) { let t = L5t.get(e); … L5t.set(e, {manifestSlots, revision$, slots: []}) }
// L5t = new WeakMap
```

`composerController`（builder入力の同名field）が拡張slot registryのWeakMap keyになった。
未指定だと`undefined`がkeyになり、`WeakMap.set`が即座に例外を投げる。旧bundleはこの合成段自体を
持たなかったため、引数を渡していなくても成立していた。

## 裁定

- builderへ専用の空object 1個を`composerController`として渡す。`T5t`はkey未登録なら
  `slots: []`の新規entryを作るので、UI composerを持たない本connectorでは拡張寄与ゼロで解決される。
  turnごとに作らずbridge scopeで使い回す（WeakMapなのでbridge破棄で回収される）。
- builder検出markerへ`composerController`を追加し、この契約変化をfail-closedで検出する。
- DOM selector、React fiber、UI eventへのfallbackは追加しない。

## 実測

- 再現: 0.4.10 global installで`chat --prompt ping` → `CHAT_FAILED: Invalid value used as weak map key`
- 特定: page側で`WeakMap.prototype.set/get`を一時的に包んで不正key時のstackを捕捉
  （`T5t` ← `P5t` ← `r4t` ← builder）。計測後にnative実装へ復元済み。
- 修復後 source版`chat --prompt ping`: `finished_successfully` / `pong` / `gpt-5-6-thinking`
- focused tests 7/7、`pnpm check` 127/127、lint・typecheck成功

## 教訓

sender／builderの**検出**を直しても、**呼び出し引数の契約**は別に壊れうる。marker修復だけで
release smokeにlive Chat送信を含めないと、この層のdriftは検出できない（0.4.10のrag記録は
「Chat送信: 未実施」だった）。
