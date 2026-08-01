# Changelog

## 0.4.11 — 2026-08-01

- ChatGPT現行bundleの公式builderがcomposer拡張slotを`composerController`をkeyとするWeakMapで
  引くようになり、未指定のturnが`CHAT_FAILED: Invalid value used as weak map key`で全失敗して
  いたため、拡張slotが空で解決される専用objectを渡すよう修復した。chat、consult、画像生成が
  同じ経路で復旧する。
- builder検出markerへ`composerController`を追加し、この契約が再び変わった場合はfallbackせず
  `RUNTIME_DRIFT`で停止する。DOM、React fiber、UI eventへの依存は追加していない。
- MCP callerが他providerのmodel（Claude、Gemini等）を使う場面で本serverを誤って呼ぶのを防ぐため、
  server instructions冒頭をChatGPT専用のprovider境界宣言に変え、各tool descriptionへ対象provider、
  `model`／`effort`へ「`chatgpt_models`が返すChatGPT slugだけ」の注釈を追加した。tool名、入出力、
  既存の呼び出し契約は変えていない。

## 0.4.10 — 2026-07-31

- ChatGPT現行bundleで公式senderがprepare本体からfollowup前処理wrapperへ変わり、旧markerが候補0件に
  なっていたため、一意性を維持した現行wrapperの構造markerへ更新した。
- 専用Chromeのlive diagnostics、page bridge初期化、model catalog取得まで確認した。DOM、React fiber、
  UI eventへの依存は追加していない。

## 0.4.8 — 2026-07-23

- Chrome 150がCDPの`minimized`要求へ成功応答しながら実状態を`maximized`のまま維持する場合でも、
  専用PIDのAppKit `hidden`状態とWindowServer表示window 0件を正本にして`browser start`を成立させる。
  target/windowの存在、公式origin、認証、page bridgeは引き続きfail-closedで検証する。
- `browser show`のendpoint所有者確認を500ms probeから専用graceへ分離した。
- ChatGPT現行bundleで公式送信関数の内部構造が変わったため、minified識別マーカーを更新した。
  live model catalog取得まで実機確認済み。

## 0.4.7 — 2026-07-20

- `npm pack` 前にcheckとbuildを必ず実行する `prepack` gateを追加した。0.4.6はsource更新後の
  `dist` 再生成がtarballへ反映されず、CLI実体が0.4.5のままだったため、0.4.7で修正版distを再公開する。

## 0.4.6 — 2026-07-20

- `browser start` の短いCDP probe timeoutから既存endpoint所有者検査とWindowServer可視性収束待ちを
  分離し、起動境界で間欠的に出ていた `RUNTIME_DRIFT` / `CDP_UNAVAILABLE` を防いだ。
  profile・所有PIDの照合条件と最終 fail-closed 判定は維持する。

## 0.4.5 — 2026-07-19

- 長寿命MCP processのCDP clientが無応答になった後も永久にcacheされ、`consult`の事前model確認と
  `diagnostics`が以後すべてtimeoutする問題を修正した。`CDP_UNAVAILABLE`を返したclientだけを退役し、
  失敗した操作は自動再送せず、次回のtool呼出しで専用Chromeへfresh接続する。

## 0.4.4 — 2026-07-18

- 画像生成turnがChatGPT内部sender promise未解決のままruntime timeoutする問題を修正した。
  完了判定をthread側の終端assistantメッセージ観測に切り替え、senderは失敗伝搬のみに使う。
- 画像生成のresolved model照合を、画像tool操作サブターン名義(実測: gpt-5-4-auto-thinking)ではなく
  turnのuserメッセージ側`resolved_model_slug`で行うようにし、誤`MODEL_RESOLUTION_MISMATCH`を解消した。
  本物のmodel降格は引き続き照合失敗として検出される。

## 0.4.3 — 2026-07-18

- dead writerの非terminal jobをread-only `sessions`が`JOB_RECOVERY_UNAVAILABLE`へ回収した後、
  `get()`の台帳再読込でraw stateへ巻き戻す問題を修正した。read-only回収は台帳を書き換えない。

## 0.4.2 — 2026-07-18

- 画像生成の`MODEL_RESOLUTION_MISMATCH`へrequested／resolved model・effortを含め、失敗jobを
  `sessions`で回収した時に安全な選択metadataまで診断できるようにした。promptや画像情報は記録しない。

## 0.4.1 — 2026-07-18

- 画像生成だけruntime operation待機上限を180秒から360秒へ延長し、生成画像のdownloadが揃った直後に
  connector側timeoutが先に発火して結果を失う問題を修正した。通常Chatとuploadの上限は変更しない。

## 0.4.0 — 2026-07-17

- ChatGPT通常枠の画像生成を正式機能化し、CLI `image` とMCP `chatgpt_image` を追加した。
- 生成画像はserver conversationの同一turnとLibraryの`origination` metadataを相関し、MIME、byte数、
  dimensions、SHA-256を照合してから256KiB chunkでローカルへ回収する。
- 保存先をabsolute `workspaceRoot` 配下へ限定し、root外symlink、既存file上書き、MIME／拡張子不一致を
  fail-closedで拒否する。複数枚は決定的suffixで保存する。
- 画像jobを既存slug台帳と`sessions`回収へ統合し、会話は成功・失敗ともarchiveする。local保存とdigest
  再検証後、生成元だけをChatGPT LibraryのRecently Deletedへsoft-deleteし、失敗／partialも結果へ明示する。
- 画像jobはrequested model／effortとassistantのresolved metadataの完全一致を必須にし、runtime側の暗黙model
  変更を`MODEL_RESOLUTION_MISMATCH`で拒否する。

## 0.3.1 — 2026-07-14

- live browser launcherがmacOS専用である契約に合わせ、LinuxとWindowsのfactory diagnosticsを
  CDP不備の`not_ready`ではなく`unsupported`として報告するよう修正した。

## 0.3.0 — 2026-07-14

- BugHub factory向けに `gpt-connector factory-diagnostics --json` を追加した。既存
  `gpt-connector.diagnostics.v1` の `doctor` 契約は維持する。
- 明示的な canonical dotagents `collection.enabled: true` の時だけ動く、network I/O を
  持たない product-owned `runtime-errors` local aggregate を追加した。
- runtime error の公開面は固定 code/template と SHA-256 fingerprint のみを使う。prompt、
  応答、添付、識別子、credential、CDP dump、絶対 path、raw error は保存・出力しない。
- true headlessを使わず、cold startでは窓なしで専用profileのheadful Chromeを起動し、CDPで
  ChatGPT targetを最初から最小化状態で作成・確認してからapp readyを待つ`gpt-connector browser start`
  を追加した。既存endpointもapp probeより先に最小化する。現行macOS実測では最小化中も送受信を維持する。
- `gpt-connector browser show`で、正規専用profileの一意ChatGPT windowだけを明示的に表示へ戻せるようにした。認証要求時はstartが同じwindowを表示へ戻してから`AUTH_REQUIRED`を返す。
- window stateのCDP read-backを有界pollにし、非同期遷移直後の旧stateによるfalse failureを防いだ。
- cold startはhidden Chrome・background minimized targetから開始し、最小化確認後に正規PIDだけをunhideしてからprobeする。
- showはCDP stateのstale値に依存せず`Page.bringToFront`を送る。最終状態はWindowServerの正規PID/layer 0 window数で確認する。
