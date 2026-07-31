# ChatGPT sender wrapper drift復旧

- 出典: ログイン済み専用Chromeで読み込まれたChatGPT静的asset、gpt-connector 0.4.9/0.4.10ローカル実測
- 取得・実測日: 2026-07-31
- 確度: 高
- 秘密情報: token、cookie、account ID、conversation本文、request bodyは取得・保存していない

## 症状

`gpt-connector browser start`と`doctor`が`RUNTIME_DRIFT`で停止し、sanitized CDP例外は
`RUNTIME_DRIFT:sender:0`を示した。CDP、公式origin、認証は正常で、page bridgeだけが未初期化だった。

## 原因

公式sender exportの公開された呼出し形は1引数のままだが、関数sourceの構造が変わった。旧版は
prepare stateを直接扱う本体を識別していたが、現行bundleではfollowup sourceを前処理して内部送信へ
委譲し、settled callbackを後処理するwrapperになったため、旧markerは候補0件になった。

## 裁定

- export名やminified symbol名には依存しない。
- 1引数async functionという呼出し形に加え、prompt message、followup source、onboarding分岐、
  settled callbackの4構造markerすべてを要求する。
- live moduleで候補が厳密に1件であることを確認し、0件・複数件は引き続きfail-closedにする。
- DOM selector、React fiber、UI eventへのfallbackは追加しない。

## 実測

- focused tests: 9/9
- typecheck: 成功
- source版`browser start`: `already_ready`
- factory diagnostics / doctor: `ready`
- live model catalog: 14モデル、default `gpt-5-5`
- Chat送信、upload、添付、conversation作成: 未実施
