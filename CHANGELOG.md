# Changelog

## Unreleased

## 0.10.0 - 2026-09-24

- Grok Chatの本文相談を同じMCPに追加した。専用ChromeのGrok tabで公式Web runtimeを使い、会話継続、同時送信、回答のサーバー照合、Codex／Cursor親への完了通知、soft deleteによる終了に対応する。Grokの送信は自動modeのみで、添付・画像生成は含まない。
- 別のAIクライアントからの相談が重なると後続を拒否する問題を修正した。job台帳は短いtransaction lockで更新し、実行中のjobをprocessごとに所有する。ChatGPT page bridgeの同時初期化も一回にまとめる。
- job台帳をversion 5へ更新する。version 1〜4の台帳は初回書込み前に元形式のbackupを残して移行する。旧版へ戻すには全MCPを停止し、version 5の台帳を退避して移行前のbackupを戻すか、旧版専用の空state directoryを使う。移行後の回答はversion 5を読める版で回収する。
- MCPは13 toolsを公開する。Codexの旧版生成値と完全一致する7件の`enabled_tools`だけ13件へ更新し、利用者が変更した制限は保持する。

## 0.9.12 - 2026-09-23

- Linuxの専用Chrome非表示／再表示が、呼出元と異なるDISPLAY上のwindowを見逃さないよう直した。Chrome processの`DISPLAY`とローカルXを順に探し、所有PIDの子孫windowも対象にする。MacとWindowsの起動・表示制御は変更しない。
- Linuxで公式Google Chromeの専用起動、`127.0.0.1:9223`の所有確認、X11 windowの非表示／再表示に対応した。liveの準備と診断はMac・Windowsと同じ入口を使う。
- Codexへの自動SteerはLinuxでは未対応のまま。MacとWindowsの起動・所有確認・表示制御は変更しない。
- X11の`DISPLAY`が無いLinuxは専用Chromeを起動しない。liveブラウザを提供しないOSのsetupは従来どおり`partial`。

## 0.9.11 - 2026-09-22

- setup試験が本物のCursor hooksへ書き込まないよう、Cursor hook登録を依存として注入できるようにした。0.9.10のWindows CI失敗を直す。機能は0.9.10と同じ。

## 0.9.10 - 2026-09-22

- Cursor親の相談完了を、実行中ターンの次のツール返りへ`postToolUse` hookの`additional_context`で差し込む。`afterMCPExecution`でconversationとdeliveryを結び、受信箱へ本文を置く。idle時の背景シェル受け口は維持する。
- `gpt-connector setup`が`~/.cursor/hooks.json`へ自分の`afterMCPExecution`と`postToolUse`だけを登録する。他製品のhookと位置は保持する。
- Claude／Codexの配送契約は変更しない。

## 0.9.9 - 2026-09-22

- Cursor親の`consult`は受付後に戻り、`receiveCommand`を返す。背景シェルで回した受け口へ、完了時にMCPが回答を一度だけ押し込む。Claude／Codexの配送契約は変更しない。
- `gpt-connector cursor-receive --delivery <uuid>`を追加した。配送socketの切断は`unknown`として終了する。
- Cursor client名の判定、Codex親への非干渉、socket押し込み、`receiveCommand`付与をfocused testで確認する。

## 0.9.8 - 2026-09-21

- 他製品がCodexのhookを後から追加すると、setupが登録済みhookを末尾へ移動し、再起動を繰り返し要求する不具合を修正した。同じ登録は位置とファイルを保持する。
- 他製品の追加後にsetupを再実行しても、稼働中Codexへの再起動要求が増えないことを回帰試験で確認する。
- 台帳・hookの形式は変更しない。旧版が既に記録した再起動待ちは完全再起動で解消する。旧版への切戻しは同じ不具合が再発する。

## 0.9.7 - 2026-09-21

- macOSの永続PTY等から旧中継を解除すると、呼出元のBackground環境だけを確認し、DesktopのAqua環境に`CODEX_CLI_PATH`が残る不具合を修正した。GUI環境を明示して操作・読戻しする。
- 解除済みと記録された旧launcherも実環境に残っていれば移行未完了として検出し、公式hookの確認後に解除する。他製品の起動設定は保持する。
- 台帳・hookの形式は変更しない。旧版へ戻しても解除済みのGUI設定は保持されるが、旧版の移行診断はこの残存を検出できない。

## 0.9.6 - 2026-09-19

- Windowsの専用Chromeが呼出元の終了jobを継承し、Codex等の終了に巻き込まれる不具合を修正した。標準WMIで非表示・独立起動し、既存の共通launcherで所有者・接続・表示状態を確認する。
- 回答生成後のarchive API失敗を`CHAT_FAILED`へ誤分類する不具合を修正した。`ARCHIVE_FAILED`とHTTP statusを報告し、認証失敗の分類は保持する。
- 呼出元jobの終了前後で子の生存を測るWindows試験と、archive APIのHTTP失敗試験を追加した。台帳・hook・設定の形式は0.9.5から変更しない。

## 0.9.5 - 2026-09-19

- 非同期相談でCDP接続が失敗すると、Chromeの復旧後も閉じた接続を保持し、後続の相談が失敗し続ける不具合を修正した。失敗結果の保存と配送を終えてから、次の新しい要求で接続し直す。同じ相談は自動再送しない。
- 受付前・受付後の切断、保存済み失敗結果の取得、並行要求での接続共有、結果保存失敗の伝播を回帰試験で確認する。Chrome自体が停止した原因を修正する変更ではない。
- 台帳・hook・設定の形式は0.9.4から変更しない。

## 0.9.4 - 2026-09-19

- ChatGPT Webの標準API clientと録音用adapterが同じモデル一覧を返す変更に対応した。通信前のURL解決で標準経路を照合し、録音用adapterを除外する。公開export名への固定や追加のHTTP要求を使わず、接続・モデル取得・通常Chatを復旧した。
- 公式Codex配送の実機試験をMac・Windowsの7条件で確認した。試験子processへWindowsの標準環境を渡し、公式dynamic toolで副作用なしにPostToolUseを発火させ、終了時はstdioの閉鎖まで待つ。
- 台帳とhookの形式は0.9.3から変更しない。巻き戻し時のhook解除・旧台帳復元条件は0.9.3の記載に従う。

## 0.9.3 - 2026-09-19

- Codexの起動へNode中継を挿入する方式を、公式キューと同期hookへ移行した。gpt-connector単体で導入・承認・配送でき、Aitermの実行や設定は不要。Mac・Windowsで同じ制御を使う。
- setupは自分の2つのhookを公式APIで承認・読戻しした後、自分が所有する旧起動設定を解除する。他製品のhook・承認・起動設定を保持し、導入前から動くCodexは生成時刻付きPIDで識別して再起動を要求する。HomebrewのNodeは版に依存しないopt入口を登録する。
- 実行中の回答は同一ターンへ取り込み、終了後は公式キューで再開する。配送ID・本文hash・単一claimで他の入力と区別し、hook出力失敗は本文を保存してsessionsへunknownを返す。
- 台帳をversion 4へ更新する。version 1・2・3の保存済み回答を読め、初回書込み前に元台帳を対応する.v1-backup／.v2-backup／.v3-backupへ退避する。
- 巻き戻し: この版のsetup --codex-steer disableでhookを解除してCodexを完全終了する。全MCPを停止し、version 4台帳を退避して対応する旧台帳backupを復元するか旧版専用の空state directoryを使い、旧版をinstall・setupする。backup以降の回答はversion 4を読める版で回収する。公開versionとtagは移動しない。

## 0.9.2 - 2026-09-14

- 通常Chatとconsultの回答待ちに設けていた10分の期限を撤去した。Proを含め、生成の成功・明示的な失敗・通信エラーまで待ち、経過時間だけで相談を失敗にしない。
- 仮想時刻で10分超の回答待ちと、完了後に同じ会話を継続できることを検証した。接続、upload、画像生成などの期限は変更しない。

## 0.9.1 - 2026-09-14

- Windowsで別実装になっていたCodexの起動・中継・設定判定を、Macの既存動作へ統一した。引数判定、JSONL中継、設定の有効化・競合・復元・既存接続との共存は共通コードが所有する。
- Windowsの標準プロセスAPIで、公式Codexを起動元の直接の子、中継を公式Codexの直接の子として起動する。起動exeは終了監視だけを行い、JSON-RPCを通さない。接続方式、ハンドル継承、ACL、ユーザー環境変数、MSIXの実体パスはWindowsの環境適合として扱う。
- AitermのWindows対応を参考に移植し、必要な実装は本packageへ同梱した。Aitermの導入・起動・APIに依存しない。Macの導入済みlauncherが使う入口も維持する。
- 0.9.0のWindows対応完了という判定を撤回する。実機での通信成功だけでは、Macと同じ仕組みという条件を満たしていなかった。
- 巻き戻し: job台帳とSteer設定schemaは変更しない。起動設定の解除はこの版の setup --codex-steer disable を使う。他から変更された起動設定はMacと同じく上書きしない。

## 0.9.0 - 2026-09-13

- Windowsで専用Chromeの起動・非表示・ログイン用表示と、setupからlive接続までを利用できるようにした。標準導入先の探索、CIMによる所有PIDと引数の照合、Win32表示制御、ACLはWindows専用コードが所有する。ログイン状態は専用profileに保存し、次回起動でも再利用する。
- Windowsの公式Codex Desktopへの自動Steerに対応した。Windows標準.NET Frameworkで起動fileを作り、認証付きのloopback WebSocketで公式CLIと接続する。本人の接続記録、PIDと生成時刻、MCPの親子関係を照合する。setupがユーザー環境変数を設定し、初回はCodexの完全再起動が必要。
- 共通の会話・添付・画像・監視・配送処理を維持した。既存MacのChrome制御とUnix socket中継は変更しない。
- 巻き戻し: job台帳は0.8.0と同じversion 3。Windowsの中継を解除するときは、この版で`setup --codex-steer disable`を実行し、Codexを再起動してから旧版を導入する。0.8.0へ戻すとWindowsのlive機能は利用できない。

## 0.8.0 - 2026-09-13

- Codex親の`consult`は受付後に戻り、MCPのコードが10秒ごとにChatGPTの完了を確認して回答または失敗を自動Steerする。利用AIの監視ループを不要にした。実行中は同じターンへ入り、終了後は同じタスクで受信する。
- 接続用の起動中継とsetupを同梱した。Aitermは参考元であり、インストール・コマンド・設定ファイルへの実行時依存はない。macOSの公式Codex Desktopを使い、導入・確認・解除を`gpt-connector setup`で行う。
- 宛先をCodexの要求metadataと同じ親processに限定し、配送不可なら相談送信前にエラーにする。既存の公式接続とは設定を変更せず共存し、確認できない別設定は上書きしない。
- 配送IDと状態を台帳version 3へ保存し、送信中断で受付が不明な場合は自動再送しない。ChatGPTの回答は`sessions`から回収できる。version 1・2の初回更新前に元の台帳を対応する`.v1-backup`／`.v2-backup`へ保存する。
- 巻き戻し: 旧版はversion 3を読めない。全MCPを停止してversion 3の台帳を退避し、対応する旧台帳backupを復元するか旧版専用の空state directoryを使う。backup以降のjobはこの版以降で回収する。Steer接続も解除する場合は、この版で`setup --codex-steer disable`を実行してからCodexを再起動し、旧版を導入する。

## 0.7.1 - 2026-09-13

- 公式uploadがソースファイルのMIME型を確定すると添付を拒否していた不具合を修正した。ファイルのidentityと会話への読戻し照合は維持する。
- 通常Chatの内部待機を最低10分にし、Proの回答を3分で失敗扱いする不具合を修正した。
- runtime snapshotに実発生時の`product_version`を公開し、導入版と発生版を区別できるようにした。

## 0.7.0 - 2026-09-13

- `consult`に`sessionId`と`wait`を追加した。`keepOpen=true`・`wait=false`で回答完了前に会話IDを返し、同じIDと新しいslugで前提を再送せず相談を続けられる。既定の同期応答とone-shot archiveは維持する。
- 会話を専用Chromeのpage bridgeで保持し、MCP再接続後も継続・明示closeできるようにした。page再読込・Chrome終了・bridge更新でIDは無効になる。結果の自動通知は含まない。
- MCP説明と入力schemaに、会話IDと問い合わせslugの区別、前提の再送省略、結果回収と終了方法を明記した。CLIの`consult --session-id`にも対応した。
- 受付IDの保存に伴いjob台帳をversion 2へ更新した。version 1は読取り可能で、初回書込み前の台帳を`consult-jobs.json.v1-backup`へ保存する。
- 巻き戻し: 旧版はversion 2を読めない。全MCPを停止し、version 2の台帳を別途退避してからversion 1のbackupを復元するか、旧版専用の空state directoryを指定する。backup以降のjobは旧版で回収できず、version 2の台帳をこの版以降で読む必要がある。新旧版のMCPを同じstate directoryで併用しない。

## 0.6.1 - 2026-09-13

- MCPの共通説明とChat・相談・画像生成のツール説明に、呼び出し元AIの会話・作業前提・ローカルファイル・リポジトリの知識がChatGPTへ自動共有されない警告を追加した。
- 目的・背景・制約、GitHub等のURLや必要な資料・コードを明示し、参照できない資料は本文または添付で渡すよう案内する。根拠がなければ仕様やコードを捏造した回答になり得ることを明記した。

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
