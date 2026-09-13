# Changelog

## 0.6.0 - 2026-09-13

- 通常Chatの最新スライダーに一致する5段階を`level`／CLIの`--level`で選べるようにした。指定を省略すると最新の右端を使う。
- 段階の順序とmodel／effortを公式runtimeの最新presetから取得し、モデル更新へ追従する。effortが無いpresetには値を補わず、利用不可・定義の変化・実行結果の不一致は明示的に失敗させる。
- 保存済みconsultを返す前に最新の利用可否を再検証していた処理順を修正した。既存のmodel／effort明示指定と7つのMCP tool、state schemaは維持する。

## 0.5.3 - 2026-09-12

- WindowsのsetupがGit付属tarを選ぶと、バックアップ先のドライブ文字を接続先と解釈して登録に失敗する欠陥を修正した。製品のplatform処理がWindows標準tarを直接選び、呼出し元のPATHに依存せず設定を保存する。
- Gitのtarを優先するWindows環境で、旧処理の失敗と修正後のバックアップ内容の一致を検証する回帰試験を追加した。既存設定の保持、MCPの7 tools、state schemaは変更していない。

## 0.5.2 - 2026-09-10

- 製品CIのLinux指定を現役のlinux-workstationへ更新し、退役済みWSL専用runnerへの待機を除去した。Mac・Linux・Windowsの製品試験と、全OSのMCP/state機能を維持する。
- 0.5.1はWindows試験を通過したが退役runner待ちで公開できず、npmへ公開していない。

## 0.5.1 - 2026-09-10

- Windowsの配布物検査でnpm.cmdの直接起動がEINVALになる問題を修正。setupと検査は同じ製品内npm起動処理を使う。
- 0.5.0はWindowsの公開前gateで停止し、npmへ公開していない。

## 0.5.0 — 2026-09-10

- `npx --yes gpt-connector@latest setup`で、実行版のnpm global導入、Claude・Codex・Grok・CursorへのMCP登録、state読取りとMCP接続確認、Macの専用Chrome準備を連続実行する。
- `setup --check`は設定変更・ブラウザ起動なしで診断する。手動ログイン待ち、登録・準備の失敗、非Macのlive未対応は成功と分けて返す。
- 既存command、args、env、認証、モデル、他MCP、利用者の無効化・ツール制限を維持し、Codexのtimeout等は不足keyだけを補う。TOMLは既存値・コメント・整形を残して挿入する。
- `--ai`による対象選択、`--codex-config`による既存project設定の移行を追加。更新前の設定を製品所有directoryへtarで保存する。
- Windows/Linuxのnpm package、MCP、store/state読取りを維持した。state schemaと既存7 toolsの契約は変更していない。

## 0.4.19 — 2026-08-30

- 専用Chromeの非表示契約を、実装どおりAppKit `hidden`とWindowServer表示window 0件へ統一した。
  CDP `minimized`はcold target作成時のhintだけとし、start／show成功の証拠に使わない。
- 現行製品文書と完了履歴を分離し、install、状態、復旧、更新、releaseの正本をgpt-connector自身へ戻した。
  npm packageにはREADMEから参照する文書地図、installer、attachment、release文書を同梱する。
- 最終4環境CIを製品repository内のreusable workflowへ移し、tag起点のGitHub ActionsだけがOIDC provenance付きで
  npm公開する。local `npm publish`はrelease手順から除外した。
- `doctor`は画面を変えない診断に固定し、認証切れでは`browser show`が正規専用Chromeだけを表示する復旧手順を明記した。
- 実npm packのMarkdownリンクを検査し、現行attachment契約から参照する成立履歴も配布する。
- publish前のclean worktreeと`origin/main`祖先性を、package、CI、release手順の共通入口で検査する。

## 0.4.18 — 2026-08-29

- MCPのserver instructions、tool description、model field descriptionから、呼べない他providerの固有名を除去した。否定文に含めたFable等がtool discovery検索へ一致し、gpt-connectorを誤候補として返す欠陥を根治する。
- discovery textはChatGPTの肯定能力と`chatgpt_models` catalog境界だけを記述する。実行時のcatalog fail-closed、tool名、入出力、ChatGPT専用provider境界は不変。

## 0.4.17 — 2026-08-24

- OS依存の判定をplatform層へ集約する挙動不変リファクタ（harness用語統一campaignの分離規約）。
  macOS専用面のゲートを`platform/darwin.ts`の`isDarwin()`へ一本化し（browser start/show・
  factory diagnosticsの3箇所）、`platform/state.ts`内のWindows判定を`isWindows()`へ統一、
  runtime error storeのOS文字列検証を既存`safePlatform()`の再利用へ畳んだ。
  公開API・エラーメッセージ・診断schemaは不変。

## 0.4.16 — 2026-08-23

- ChatGPT現行bundleでthreadStore・treeApi・apiClient・threadGetter・conversationFactoryの
  export群がcore chunkから共有chunkへ移動し、bridge初期化が`RUNTIME_DRIFT:threadStore:0`で
  全機能停止していたため、共有chunkを第4のruntime assetとして一意検出（marker:
  `setServerIdForNewThread`等）し、5役の解決先を共有moduleへ切り替えて修復した。
- 現行bundleは任意のkeyへ関数を返すlazy proxy exportを含み、store shape判定を全通過して
  一意検出を壊すため、実在しないkeyが関数として返る候補を一意化の前に除外する。
- RUNTIME_DRIFT診断へ`sharedFingerprint`を追加した。DOM・fiber・UI eventへの依存は
  引き続き追加していない。

## 0.4.15 — 2026-08-23

- OS依存コードを`src/platform/`へ分離した。macOS専用プリミティブ（`open`によるChrome起動、
  JXAのwindow/process制御、lsof/psのポート所有確認）は`platform/darwin.ts`、OS別のstateパス解決と
  権限強制（POSIX chmod／Windows icacls ACL）は`platform/state.ts`だけが持つ。browser-launcherと
  各storeからOS分岐を排除し、片方のOSの修正が他方を壊す構造を解消した。公開APIと挙動は不変
  （Windowsのstore書込でrename後のACL適用が1回増えるだけで最終状態は同一）。

## 0.4.14 — 2026-08-15

- Windowsのowner-only ACL検証で、`whoami`と`icacls`がmachine名の大文字小文字を
  異なる表記で返しても同一accountとして照合する。runtime-error snapshotとackが
  `windows acl verification`で停止し、BugHub deliveryを閉じられない欠陥を修復した。
- npm公開metadataを移転後の正規repository `kitepon/gpt-connector`へ更新した。

## 0.4.13 — 2026-08-15

- MCP `diagnostics`をlive操作と同じerror telemetry経路からread-only `doctor`へ分離した。
  専用Chrome未接続・live connector非対応hostでも固定diagnostics JSONを正常応答として返し、
  診断しただけで`CDP_UNAVAILABLE`のhigh severity runtime errorを作らない。
- `chatgpt_models`、Chat、consult、画像生成など実操作のCDP障害は、従来どおりruntime-error storeへ
  記録する契約を維持する。

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
