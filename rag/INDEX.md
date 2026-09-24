# rag/ INDEX

調査・研究の再利用棚。一次ソースは `raw/`、要約・実測・判断はコンパイル記事に分離する。

- [chatgpt-app/windows-browser-archive-causes-20260919.md](chatgpt-app/windows-browser-archive-causes-20260919.md) — Codex終了jobを継承するChrome起動と、archiveのHTTP 500を回答失敗へ誤分類する欠陥の再現・修理（2026-09-19）
- [setup/raw/windows-job-lifetime-20260919.md](setup/raw/windows-job-lifetime-20260919.md) — Microsoft公式のjob継承とWMI process作成の一次資料（2026-09-19）
- [chatgpt-app/async-consult-cdp-reconnect-20260919.md](chatgpt-app/async-consult-cdp-reconnect-20260919.md) — 非同期相談の接続失敗がMCPの接続破棄へ届かない欠陥を再現・修理。Chrome停止原因の未解明と区別（2026-09-19）
- [chatgpt-app/codex-queue-hooks-20260919.md](chatgpt-app/codex-queue-hooks-20260919.md) — 公式キュー・同期hookによる単独配送と移行、7条件の公式binary実測（2026-09-19）
- [chatgpt-app/api-client-route-20260919.md](chatgpt-app/api-client-route-20260919.md) — 標準API clientと録音adapterの重複、通信前の経路照合による修理（2026-09-19）

- [setup/windows-parity-20260914.md](setup/windows-parity-20260914.md) — Macの制御を共通化し、Windowsの直接の親子関係・単独Steer・MSIX環境を実機検証（2026-09-14）

- [setup/windows-live-20260913.md](setup/windows-live-20260913.md) — WindowsのChrome制御、認証付きCodex接続、.NET stdin bufferの最小再現と修理（2026-09-13・公式仕様＋実機）

- [chatgpt-app/codex-parent-steer-20260913.md](chatgpt-app/codex-parent-steer-20260913.md) — 同梱中継による単独起動、公式App Serverへの実行中Steer・終了後配送、10秒のコード監視（2026-09-13・公式binary実測）

- [chatgpt-app/latest-slider-20260913.md](chatgpt-app/latest-slider-20260913.md) — 最新スライダー5段階、右端の既定、Proのeffort省略、冪等な結果回収（2026-09-13・公式runtime＋製品実測）
- [chatgpt-app/raw/latest-slider-20260913.md](chatgpt-app/raw/latest-slider-20260913.md) — 公式runtimeのlatest preset定義の抜粋（2026-09-13）

- [setup/npm-publish-auth-20260910.md](setup/npm-publish-auth-20260910.md) — 3OS gate通過後のnpm E404とtrust list E401を分離し、公開設定を所有者ログイン後に確認する（2026-09-10・公式資料＋CI実測）
- [setup/raw/npm-trust-20260910.md](setup/raw/npm-trust-20260910.md) — npm trustの公式原文抜粋（2026-09-10・MarkItDown取得）

- [chatgpt-app/chatgpt-desktop-oracle-route-20260713.md](chatgpt-app/chatgpt-desktop-oracle-route-20260713.md) — 新 ChatGPT desktop app を Oracle の非 UI 代替にできるか: Codex-native consultation は可能だが quota は `codex`、consumer Chat は private integrity API のため非採用。Chat 枠分離が必要なら Oracle 継続（2026-07-13・公式資料＋ローカル実測）
- [chatgpt-app/chatgpt-cdp-bridge-static-discovery-20260713.md](chatgpt-app/chatgpt-cdp-bridge-static-discovery-20260713.md) — consumer client、`/f/conversation/*`、live `AppScope`、CDP runtime の静的 discovery。理想順位1は候補維持、次は専用のログイン済みCDP runtimeが必要（2026-07-13・ローカル実測）
- [chatgpt-app/chatgpt-web-client-runtime-discovery-20260713.md](chatgpt-app/chatgpt-web-client-runtime-discovery-20260713.md) — 公式factory→initThread→`DP`→`kF`で、DOM／React fiberなしの新規・2turn継続・公式state応答回収を実証。plain UUID失敗もnegative characterizationとして記録（2026-07-13・ローカル実測）
- [chatgpt-app/chatgpt-web-model-effort-selection-20260713.md](chatgpt-app/chatgpt-web-model-effort-selection-20260713.md) — 公式`/models` catalog、通常Chat／Work分離、`requestedModelId`＋`thinkingEffort`明示選択、assistant metadata一致、非対応組合せの送信前拒否を実証（2026-07-13・ローカル実測）
- [chatgpt-app/gpt-connector-implementation-20260713.md](chatgpt-app/gpt-connector-implementation-20260713.md) — 0.1.0 core公開から0.2.0の正規添付、durable job、diagnostics、全file pass-through、62 tests、npm公開・global smokeまでの記録（2026-07-13・ローカル実測）
- [chatgpt-app/gpt-connector-image-generation-20260717.md](chatgpt-app/gpt-connector-image-generation-20260717.md) — ChatGPT通常枠の画像生成をCLI／MCPへ正式化。turnとLibraryの二重相関、verified chunk回収、安全な保存、durable job契約（2026-07-17・ローカル実測）
- [chatgpt-app/gpt-connector-chrome150-runtime-drift-20260723.md](chatgpt-app/gpt-connector-chrome150-runtime-drift-20260723.md) — Chrome 150のCDP window state非収束とChatGPT sender marker driftを修復し、AppKit hidden＋WindowServerを表示正本へ変更（2026-07-23・公式仕様＋ローカル実測）
- [chatgpt-app/gpt-connector-sender-wrapper-drift-20260731.md](chatgpt-app/gpt-connector-sender-wrapper-drift-20260731.md) — ChatGPT現行bundleでsender exportがprepare本体からfollowup前処理wrapperへ変化し、候補0件になったruntime driftを一意marker更新で修復（2026-07-31・ローカル実測）
- [chatgpt-app/gpt-connector-composer-controller-drift-20260801.md](chatgpt-app/gpt-connector-composer-controller-drift-20260801.md) — 公式builderがcomposer拡張slotを`composerController` keyのWeakMapで引くようになり全turnが`Invalid value used as weak map key`で失敗したdriftを、専用空objectとmarker追加で修復（2026-08-01・ローカル実測）
- [chatgpt-app/chatgpt-native-attachment-discovery-20260713.md](chatgpt-app/chatgpt-native-attachment-discovery-20260713.md) — textとPNGで、DOM／file inputなしの公式runtime upload、server attachment、モデル読取、archiveまでを実証（2026-07-13・ローカル実測）
- [chatgpt-app/chatgpt-native-attachment-negative-characterization-20260713.md](chatgpt-app/chatgpt-native-attachment-negative-characterization-20260713.md) — auth／storage／empty／timeout／CDP／drift／orphan／deleteを反証し、native attachmentを「条件付きで可能」と裁定（2026-07-13・ローカル実測＋公式資料）
- [chatgpt-app/gpt-connector-oracle-replacement-evaluation-20260713.md](chatgpt-app/gpt-connector-oracle-replacement-evaluation-20260713.md) — dotagents実需要基準のOracle置換評価。0.2.0 sourceでP0機能と正規添付を充足し、外部統合を別waveとしてshadow可能と裁定（2026-07-13・ローカル実測）
- [chatgpt-app/raw/chatgpt-projects-file-attachments-20260713.md](chatgpt-app/raw/chatgpt-projects-file-attachments-20260713.md) — ChatGPT projectはローカルfolderを直接読まずupload／connected sourceを使い、chatへfileを直接添付できるというOpenAI公式記述。consumer Webのwire仕様は非公開（2026-07-13取得）
- [chatgpt-app/raw/chatkit-file-attachments-20260713.md](chatgpt-app/raw/chatkit-file-attachments-20260713.md) — ChatKitのhosted upload、file数／size／MIME設定の公式記述。consumer ChatGPT Web内部仕様の証拠には使わない（2026-07-13取得）
- [chatgpt-app/raw/chatgpt-native-upload-network-shape-20260713.md](chatgpt-app/raw/chatgpt-native-upload-network-shape-20260713.md) — 専用Chromeで観測した正規upload event順とconversation attachmentのsanitized shape。body/header値/ID/tokenは未保存（2026-07-13・ローカル実測）
- [chatgpt-app/raw/chatgpt-native-upload-runtime-contract-20260713.md](chatgpt-app/raw/chatgpt-native-upload-runtime-contract-20260713.md) — 公式upload objectの構造契約、`Retrieval=3`、公式client処理、DOM非依存runtime upload成功をsanitized記録（2026-07-13・公開静的asset＋ローカル実測）
- [chatgpt-app/raw/chatgpt-native-attachment-e2e-20260713.md](chatgpt-app/raw/chatgpt-native-attachment-e2e-20260713.md) — DOM非依存uploadからserver attachment、モデル読取、model／effort、archive、UI表示までのE2E実証と孤立upload／ID出力失敗をsanitized記録（2026-07-13・ローカル実測）
- [chatgpt-app/raw/gpt-connector-native-attachment-production-e2e-20260713.md](chatgpt-app/raw/gpt-connector-native-attachment-production-e2e-20260713.md) — production coreの15件代表matrix、PNG視覚認識、全file pass-through、server read-back、durable slug、隔離npm配布物を実証（2026-07-13・ローカル実測）
- [chatgpt-app/raw/chatgpt-native-image-generation-e2e-20260717.md](chatgpt-app/raw/chatgpt-native-image-generation-e2e-20260717.md) — 画像生成tool message、Library origination相関、eventual consistency、1024×1536 production E2Eを内部IDなしで記録（2026-07-17・ローカル実測）
- [chatgpt-app/raw/chrome-devtools-window-state-20260723.md](chatgpt-app/raw/chrome-devtools-window-state-20260723.md) — Browser/Target domainのwindow stateとbackground target契約（Chrome DevTools Protocol公式、2026-07-23取得）
- [chatgpt-app/raw/chatgpt-native-image-attachment-e2e-20260713.md](chatgpt-app/raw/chatgpt-native-image-attachment-e2e-20260713.md) — 自作PNG fixtureをconsumer通常Chatへ正規添付し、upload／server attachment／視覚認識、model／effort、archive、残存0を実証（2026-07-13・公式Docs MCP＋ローカル実測）
- [chatgpt-app/raw/openai-chatgpt-file-upload-limits-retention-20260713.md](chatgpt-app/raw/openai-chatgpt-file-upload-limits-retention-20260713.md) — OpenAI公式の対応type、512MB／2M token等の上限、Library retention／delete仕様。MarkItDown 403を明記（2026-07-13取得）
- [chatgpt-app/raw/codex-app-server-20260713.md](chatgpt-app/raw/codex-app-server-20260713.md) — OpenAI 公式 Codex App Server 全文（MarkItDown、2026-07-13取得）
- [chatgpt-app/raw/chatgpt-desktop-whats-new-20260713.md](chatgpt-app/raw/chatgpt-desktop-whats-new-20260713.md) — Codex app の ChatGPT desktop app 統合と Chat/Work/Codex の並存（OpenAI公式、2026-07-13取得）
- [chatgpt-app/raw/chatgpt-work-20260713.md](chatgpt-app/raw/chatgpt-work-20260713.md) — Chat と Work の役割境界、desktop Work と Codex の関係（OpenAI公式、2026-07-13取得）
- [Grok Webと実測した接続境界](grok/observations.md) — 公式Webの提供範囲、本文相談・継続・同時処理、回答に記録されたmodelとeffortの範囲（2026-09-24）
