# ChatGPT正規添付によるdotagents Oracle置換計画

作成日: 2026-07-13

状態: Phase 6テキスト添付実装・配布物smoke完了。Phase 7移行は凍結し、現行作業をgpt-connector内の画像添付に限定

## 目的

`gpt-connector`から、ログイン済みChatGPT通常チャットの**正規添付ファイル**を利用できるようにする。そのうえで、dotagentsコアがOracleへ求めているChatGPT Chat枠のsecond opinionを、UI操作へ依存せず`gpt-connector`へ置き換える。

ここでいう正規添付とは、ファイル内容をprompt本文へ貼り付けることではない。ChatGPT側へファイルをuploadし、会話のattachmentとして関連付け、ChatGPT画面とserver上の会話データでも添付として確認できる状態を指す。

## 今回の裁定

- 2026-07-13のscope再裁定により、dotagents／ServerManagerを含むプロジェクト外変更を停止する。明示的な再開指示までは、gpt-connector内の正規添付機能だけを扱う。
- テキストファイルは正規upload、conversation attachment、モデル読取、server read-backまで成立済み。次の未完了対象は画像ファイルである。

- 添付ファイル機能の実現調査を最初の工程にする。
- 本番経路はDOM selector、ファイル選択ダイアログ、座標操作へ依存させない。
- ブラウザはChatGPTログイン、integrity／attestation計算、公式page runtimeの利用に限定する。
- ローカルファイルを読むのは`gpt-connector`であり、ChatGPTへローカルパスを渡さない。
- 正規添付に失敗しても、黙ってprompt本文へのテキスト展開へ切り替えない。
- テキスト展開は未採用の別方式とし、正規添付が不可能と実証された場合にだけ、オーナーの別裁定を受けて再検討する。
- API engineと`OPENAI_API_KEY`は使わず、ChatGPTサブスクリプションのChat枠だけを使う。

## 理想優先順位

1. `gpt-connector`本体が正規添付、通常Chat送信、model／effort、状態回収、診断を所有し、単独でOracleを置き換える。
2. 移行期間だけ`oracle.consult`／`sessions`相当の名前を`gpt-connector`本体へ持たせる。恒久的な別adapter packageは作らない。
3. shadow試験とrollbackのためだけOracleを一時併用する。自動fallbackは作らない。

## 現在の基準点

- `gpt-connector@0.1.0`は、ChatGPT公式page内部clientによる通常Chat、model／effort選択、複数turn、archiveを実装済み。
- 現在の会話builderには`attachments: []`を固定で渡しており、upload処理は未実装。
- 25,774文字の複数text相当を`gpt-5-6-thinking／extended`へ送り、17.0秒で応答・resolved metadata・archive成功を確認済み。
- 過去30日のOracle 44 sessionではfiles利用26件、file spec 124件。実績は全てtextだが、これは正規添付を諦めてよい根拠にはしない。
- OpenAI公式文書は、ChatGPTのchatへファイルを直接添付できることと、ChatGPT projectがローカルfolderを直接読まずupload／connected sourceを使うことを明記している。
- 公開文書はconsumer ChatGPT Webのupload通信仕様を公開していない。endpoint、request schema、file ID、retention、integrity依存は実測が必要。

## 完了条件

- ローカルの無害fixtureを、UI操作なしでChatGPTへuploadできる。
- ChatGPT画面上で本物の添付ファイルとして表示される。
- server上の会話データにもattachment metadataが残る。
- モデルが添付内容を読み、fixture固有の検証値を回答できる。
- model／effortのrequested値とresolved値が一致する。
- 成功時に会話をarchiveできる。
- upload失敗、送信失敗、timeout時に、会話・operation・一時fileの状態を観測できる。
- caller timeout後に同じ相談を再送せず、caller既知のslugから状態と結果を回収できる。
- dotagentsのinstall、update、diagnostics、factory report契約へ組み込める。
- Oracleへの暗黙fallback、prompt本文への暗黙展開、個人conversation操作が存在しない。

## 非目標

- OpenAI APIを使う経路。
- ChatGPTのDOM、React fiber、file input、座標操作を本番契約にすること。
- Oracleの全preset、全CLI、全metadataの完全互換。
- Deep Research、Project Sources、画像生成を初回releaseへ含めること。
- 正規添付の実証前にdotagents側を変更すること。
- upload済みfileの削除仕様が未確認のまま「完全cleanup」と宣言すること。

## Phase 1 — 正規添付ファイル機能の実現調査

このPhaseが最初の作業である。合格するまでproduction実装へ進まない。

### 1A. 調査fixtureと観測条件

- [x] 内容、SHA-256、bytes、MIMEを固定した小さな`.txt`／`.md` fixtureを作る。
- [x] file inputは`accept`空／multiple、runtime同時上限20、OpenAI公式対応type／size上限を記録する。
- [x] 専用Chrome profile、専用の新規会話、無害fixtureだけを使う。
- [x] Network、Runtime、consoleの観測項目を決め、cookie、token、account ID、conversation IDを保存しないsanitizerを先に用意する。

### 1B. 公式添付の基準動作を観測

- [x] 研究用の一回だけ公式UIからfixtureを添付し、CDP Networkイベントでupload開始から会話送信までを観測する。
- [x] upload初期化、実byte送信、完了確認、file metadata取得、conversation attachment関連付けの段階を分離する。
- [x] request method、origin、path pattern、content type、response shapeを秘密抜きで記録する。
- [x] small fixtureのsigned single PUTを実測し、multipart／checksum／integrity／workspace headerは公式assetの条件分岐を静的確認して実走有無を区別する。
- [x] upload後のfile IDと、conversation builderへ渡るattachment objectの関係を確定する。
- [x] archiveはfile deleteではなく、孤立uploadはGET可能だがgeneric DELETE 404、retention不明と確認する。

### 1C. 公式page runtimeの静的・動的発見

- [x] bootstrap／import graphからupload client、file policy、MIME判定のmarkerを抽出する。
- [x] conversation builderとattachment normalization helperのmarkerを抽出する。
- [x] 候補が複数なら構造シグネチャとobject参照同一性で一意にし、曖昧な候補選択を禁止する。
- [x] 公式runtime関数の引数、戻り値、error callback shapeを確認する。
- [x] core／conversation asset fingerprintを取り、構造候補非一意／fingerprint drift時は送信前fail-closedとする。

### 1D. UI非依存の正規upload実証

- [x] Node側でfixture bytesを読み、base64でCDP page contextへ安全に渡す研究probeを通す。
- [x] page contextで`File`を構成し、公式upload clientへ渡す。DOM file inputは使わない。
- [x] 返却されたfile metadataを、現在`attachments: []`の箇所へ正式なattachmentとして渡す研究probeを通す。
- [x] 新規通常Chatへ送信し、ChatGPT画面に添付名が表示されることを確認する。
- [x] server会話データでattachment 1件、nameとMIMEをread-backする。
- [x] fixture固有値を質問し、モデルが添付内容を読めたことを確認する。
- [x] model／effort、応答完了、archive read-back、bridge session／operation 0を確認する。

### 1E. negative characterization

- [x] `.gdoc`非対応の公式policy、`.bin`がreadyになる実挙動、0-byte、同名signature、上限20、storage失敗を記録する。
- [x] auth 401 injection、CDP切断、runtime drift、upload timeout、upload後送信前失敗を再現する。
- [x] 各失敗で再送可否、孤立file、conversation作成有無、archive可否を記録する。
- [x] 通常file delete clientを発見したが実対象では404。`削除不能／retention不明`を明示する。
- [x] 失敗時にテキスト展開やOracleへfallbackしないことを確認する。

### 1F. 調査ゲート

- [x] UI表示、server attachment、モデル読取を揃え、反対仮説を潰して「条件付きで可能」と裁定する。
- [x] model／effort一致、archive、bridge cleanupも追加証拠にする。
- [x] delete／retention／private driftが残るため無条件可能とはしない。
- [x] 結論をRAG、INDEX、本計画へ還流する。
- [x] 不可能時の自動テキスト展開は禁止を維持する（今回は停止条件に非該当）。

## Phase 2 — 添付契約の設計

Phase 1で正規添付が可能と確認できた場合だけ進む。

- [x] 公開入力を`prompt`、`files`、`workspaceRoot`、`model`、`effort`、`slug`、`keepOpen`、`dryRun`へ絞る。
- [x] relative pathは明示`workspaceRoot`からだけ解決し、暗黙のMCP process cwdへ依存しない。
- [x] absolute path、`..`、symlink escape、秘密file patternの扱いを契約化する。
- [x] ChatGPTへ送るのはbytes、file name、MIMEだけとし、ローカルabsolute pathを送らない。
- [x] glob展開順、重複排除、file数、総bytes、単file上限を決定的にする。
- [x] `dryRun`で解決file、bytes、MIME、model／effort、upload可否を返し、uploadや会話作成を行わない。
- [x] upload result、attachment metadata、server file IDは内部値とし、外部へはslug／sessionIdだけを返す。
- [x] prompt本文への展開は別modeとしても実装しない。
- [x] 公開schema、error code、file lifecycle、保持期限を[`native-attachment-contract.md`](../native-attachment-contract.md)へ正本化し、親が反証する。

## Phase 3 — 安全網

- [x] 現行23 testsと実ブラウザone-shot／2turn／archiveをbaseline greenとして再取得する。
- [x] 現在の`attachments: []`を固定するcharacterization testを追加し、挙動修正時にattachment handle期待へ明示更新する。
- [x] upload lifecycle構造、attachment read-back、path boundary、MIME、size、secret除外のunit testを先に作る。
- [ ] upload成功、upload失敗、送信失敗、archive失敗のfixtureを作る。
- [x] private runtime markerが変わった時に送信前停止するnegative testを作る。
- [ ] 挙動不変の内部整理と、添付を有効化する挙動修正を別commit単位に分ける。

## Phase 4 — 正規添付の実装

- [x] F: upload／attachmentのprivate runtime契約、認証境界、file lifecycleを親直轄で実装・裁定する。
- [x] A: path resolver、glob、MIME、size gate、schema、unit testは仕様固定後に実装物量として分離する。
- [x] ローカルbytesをCDPへ256KiB chunk転送し、一回の巨大`Runtime.evaluate`を避ける。
- [x] 公式upload clientを呼び、upload完了read-back後だけconversation送信へ進む。
- [x] file順序をattachment順序へ保つ。`.txt`→`.md`の実ブラウザ2添付で、server read-back名／MIMEとモデル回答順を一致確認した。
- [x] 部分upload成功時の件数とcleanup状態をterminal失敗snapshotへ記録し、失敗を一括成功扱いしない。
- [x] 会話送信後にattachment metadataと応答を検証する。
- [ ] one-shot、複数turn、explicit closeの全経路でarchive契約を維持する。

## Phase 5 — 長時間処理と結果回収

- [x] callerが一意slugを事前指定するdotagents標準形を作る。
- [x] `queued／uploading／submitted／running／succeeded／failed`を持つjob台帳を製品所有領域へ置く。
- [x] prompt本文、file内容、cookie、token、conversation ID、absolute pathを台帳へ保存しない。
- [x] caller timeout後も`sessions(slug)`で同じjobを再取得できるようにする。
- [x] page operationを孤立させず、terminal result／error／cleanup状態を回収する。
- [x] process restart時はterminalを回収し、非terminalを`JOB_RECOVERY_UNAVAILABLE`へ固定して自動再送しない。
- [x] dotagentsのconsumer／正典／testsを検索し、explicit cancelの利用契約はなく、timeout後はsessions確認だけと確認した。切替前必須は段階stateとterminal回収で満たし、cancelと細粒度progressは未実装の後続候補と裁定する。

## Phase 6 — MCP／CLI／工場統合

- [x] `consult`、`sessions`、`models`、`close`の最小MCP面を確定し、既存`chatgpt_chat`も互換維持する。
- [x] `gpt-connector --version`を追加する。
- [x] read-only diagnostics／doctor JSONを追加する。
- [x] diagnosticsは固定`gpt-connector.diagnostics.v1`でpackage version、overall／reason、CDP、公式origin、auth、bridge build、open job／session／operation／upload buffer件数だけを返す。CDPなしでも`not_ready/cdp_unavailable`をstdoutへ返して非0終了する。
- [x] diagnosticsがupload、会話作成、prompt出力を行わないことを実機smokeする。
- [ ] 移行期間だけMCP server idを`oracle`のままcommandを`gpt-connector-mcp`へ差し替えられるようにする。
- [x] npm packageと隔離prefixへのglobal installを通す。公開物54件は`dist/src`、README、LICENSE、package metadataだけで、built stdio MCPの6 tool列挙、diagnostics、2添付consult dry-run、Chromeなしsessions回収も確認した。実ユーザーglobal更新はPhase 8の明示指示後に行う。

## Phase 7 — shadow試験とdotagents移行

- [x] Oracleとgpt-connectorへ同じ無害な2添付相談を別々に1回送り、結果、時間、cleanupを比較した。gpt-connectorは成功、Oracleは実添付upload timeoutで応答前にerror。Oracleは再送せずsession/logを回収した。
- [x] filesなし、単file／extended、複数file／standard、同名複数file／max、10件batch／standardを含む代表matrixを実行した。
- [x] 正規添付合計15件で、誤送信、prompt混線、file取り違え、archive漏れが0であることをserver read-backと固定markerで確認した。
- [x] code検索、failure契約、独立refuterの3方向でOracle／API／prompt本文展開への自動fallbackが存在しないことを確認した。
- [ ] dotagentsのproduct contract、factory scan、ServerManager期待schemaを同一waveで更新する。
- [ ] agents-update、verify-install、MCP登録、oracle skill、02／05／06正典、wrapper testsを同一waveで更新する。
- [ ] 旧Oracle履歴を消さず、旧client／旧hostの`not_applicable`遷移とrollbackを設計する。
- [ ] 全hostの切替はオーナー承認後に行い、端末ごとの成功／未実施を記録する。

## Phase 8 — releaseとOracle撤去

- [ ] full gate、実ブラウザgate、privacy確認、package内容確認を通す。
- [ ] 変更を独立してrevert可能なrelease単位へ分ける。
- [ ] commit、push、npm publish、global installはオーナーの明示指示後に行う。
- [ ] 全host greenと個別承認後にOracle wrapper／package更新対象を外す。
- [ ] rollbackは前版のMCP commandとpackage versionへ戻す手順として実証する。
- [ ] 全TODO完了後、本計画を`docs/archive/`へ移す。

## 検証matrix

| 区分 | 最低条件 |
|---|---|
| file | 公式対応が確認できたtext 2種、複数file、同名、空、上限超過 |
| upload | 成功、途中失敗、完了応答欠落、重複応答 |
| chat | 新規、同一conversation follow-up、model／effort別 |
| failure | auth失効、CDP切断、runtime drift、timeout、archive失敗 |
| recovery | slug lookup、caller timeout後回収、process restart |
| privacy | token／cookie／ID／absolute path／file本文がlog・job台帳・diagnosticsへ出ない |
| cleanup | conversation、page operation、connector session、一時buffer、孤立upload |

## 外部状態と安全

- 実ChatGPTへのuploadと会話作成は、Phase 1の無害fixtureを使う明示的probeだけに限定する。
- 通常Chrome profileと個人conversationは触らず、専用Chrome profileを使う。
- probe会話は成功確認後にarchiveする。deleteは行わない。
- upload objectの削除仕様が確認できるまで、削除したと報告しない。
- token、cookie、account ID、conversation ID、server file IDを文書、RAG、terminal出力へ残さない。
- private endpointやruntime functionが変わった場合はfail-closedにし、別経路へfallbackしない。

## 役割分担ゲート

- F: private upload契約、attachment schema、認証／integrity境界、job recovery、公開MCP契約、dotagents product migration。
- A: 仕様確定後のresolver、schema配線、unit test、CLI表示、docs更新。
- H: 研究用の手動基準添付、ログイン、全host切替、npm publish、push、Oracle撤去。
- 実装開始時に各作業単位でF／A／Hを再宣言し、Aを委譲する場合はrouting smokeと検証を先に通す。

## 調査知識の置き場

- 一次資料とsanitized trace: `rag/chatgpt-app/raw/`
- 実測と裁定: `rag/chatgpt-app/`
- 再利用入口: `rag/INDEX.md`
- 外部仕様の罠を確定した場合: 重複検索後にcaveatへ記録する。公開／非公開は記録前にオーナーが裁定する。

## 既知の不確実性

- consumer ChatGPT Webのupload wire protocolは公開仕様ではない。
- uploadがpage runtimeだけで完結するか、pre-signed storageや別originを使うかは未確認。
- integrity／attestationがfile bytesやMIMEへ結び付くかは未確認。
- upload済みfileの保持期間、archiveとの関係、削除方法は未確認。
- text以外の対応範囲は実測前に決めない。
- private runtime変更耐性は、markerとnegative testで高められるが、正規の公開安定APIにはならない。

## Phase 1途中経過（2026-07-13）

- `.txt` fixtureの公式UI添付を一回観測し、`POST /backend-api/files`、署名付きstorageへの`PUT /files/:uuid/raw`、`POST /backend-api/files/process_upload_stream`、retrieval確認を記録した。
- conversation requestではuser messageの`metadata.attachments`に1件入り、`id`、`library_file_id`、`mime_type`、`name`、`size`、`source`等のfieldを確認した。値そのものはfixture由来のMIME／size以外を保存していない。
- ChatGPT画面で添付表示、モデルによるfixture識別子読取、研究用会話のarchiveを確認した。
- 直接`fetch`によるarchiveは401。公式`safePatch`等のintegrity付きclientが必要。
- ページ遷移後、既存core asset markerが0件になり、現行`gpt-connector models`は`RUNTIME_DRIFT`。upload client発見と同時にcore discovery markerの再発見が必要。
- 現buildのbootstrap inline moduleから3 root assetを抽出し、同一origin import graph 9 assetを探索して公式upload objectを構造シグネチャで一意に発見した。
- Nodeで読んだ214-byte fixtureをpage contextで`File`化し、DOM／file inputなしの公式uploadを実行した。`ready`、progress 100、server file ID／file specあり、error 0件を確認した。内部ID値と署名付きURLは保存していない。
- その後、UI非依存upload結果を公式conversation builderへ渡し、server attachment 1件（`probe.txt`／`text/plain`）、モデルによるfixture識別子の完全一致回答、resolved model／effort一致、archive read-back、session／operation 0を確認した。
- senderが開いた研究用conversation documentへ対象添付名だけをboolean問い合わせし、UI表示もtrueだった。これでPhase 1Dは完了した。
- 再現試験のconversation asset探索が送信前に失敗した1回では、直前のupload 1件が孤立した。削除手段未確認のためcleanup済みとは扱わず、Phase 1Eへ持ち越す。
- CDP target URLをterminalへそのまま出した1回で研究用conversation IDが表示された。保存はしていない。以後はorigin／path分類またはbooleanだけを返す。
- archive操作探索時、広すぎるbutton一覧が既存chat titleをterminalへ出した。本文／ID／tokenは出力せず、ファイル保存もしていない。以後は一意`data-testid`と対象文字列だけを問い合わせ、一覧取得を禁止する。

## Phase 1裁定（2026-07-13）

**条件付きで可能。** UI非依存の公式runtime upload、server attachment、モデル読取、UI表示、model／effort一致、archiveまで成立した。条件はbootstrap/import graph discovery、fingerprint driftのfail-closed、local file policy、job recovery、retention不明の明示、暗黙fallback禁止である。generic file DELETEは404で、完全cleanupは未成立。

## Phase 6実機・配布物追試（2026-07-13）

- production coreから`probe.txt`と`probe.md`を指定順で正規添付し、server read-backの名前／MIME順、モデルが返した両識別子の順、`gpt-5-6-thinking／standard`、archiveを一致確認した。本文貼付け、DOM、file input、Oracle/API fallbackは使っていない。
- `pnpm check`、build、diff checkは57 testsを含めてgreen。
- npm tarballを一時領域へ作り、隔離prefixへglobal installした。実配布物からCLI version、stdio MCP 6 tools、terminal sessions回収、2添付dry-run、read-only diagnosticsを確認した。
- 初回のpackage smokeは試験側がstate directoryを`0755`で先に作り、製品のowner-only検査が`JOB_RECOVERY_UNAVAILABLE`で拒否した。`0700`を製品に作らせる正しい条件では合格したため、安全検査を緩めていない。
- MCP tool列挙順は契約にせず、tool名の集合を契約とする。
- dotagents factory統合のためdoctorを成功／失敗共通schemaへ固定した。liveは`ready`かつoperation／upload 0、CDPなしは`not_ready/cdp_unavailable`かつnullable countで、会話・uploadを作らない。

## Phase 7反証・shadow途中経過（2026-07-13）

- 独立refuterが、live writer中に初期化したstatus observerのsnapshot陳腐化と、同一processの複数active jobで最初のterminalがwriter leaseを早期解放する反例を発見した。
- status／同slug再consult時のatomic台帳再読込、最後の非terminal jobまでのlease保持、既所有leaseでの追加reserve時にin-memory台帳を維持する修正を入れた。
- observerのterminal再取得、同slug`created:false`回収、複数active job完遂を回帰testへ追加し、59 tests／build／diff checkをgreenにした。
- 修正後の同じ2反例は独立refuterが再反証し、いずれも不成立と確認した。この狭い範囲では新しい成立指摘なし。
- 同一promptと`probe.txt`／`probe.md`を各製品へ1回送るshadowでは、gpt-connectorが両識別子の順序、server read-back、model／effort、archiveまで成功した。Oracle 0.16.0はbrowser／real attachment／archive autoで開始したが、`Attachments did not finish uploading before timeout`で応答前にerrorとなった。再送はしていない。
- Oracle正典skillは0.15.2前提だが実体は0.16.0だった。dotagents移行waveで`docs/06_oracle-mcp.md`とskillのversion・挙動差分を更新対象にする。
- gpt-connector代表matrixは、添付なし、単file／extended、2file／standard、同名2file／max、10file／standardを完走した。正規添付は合計15件、server read-back／固定marker／archiveで取り違え・混線・漏れ0。
- 10file試験は48.0秒、同名2file／maxは74.9秒。いずれも`gpt-5-6-thinking`のrequested／resolved effortが一致した。
- dotagentsの現行consumerと正典にはexplicit cancel利用がなく、長時間失敗後はsessions確認が契約。初回切替に必要なのは段階stateとterminal回収であり、cancelと細粒度progressは未実装の後続候補と裁定した。

## 参照

- [旧Oracle置換評価](2026-07-13-oracle-replacement-evaluation-plan.md)
- [OpenAI公式 Projects, chats, and tasks](https://learn.chatgpt.com/docs/projects)
- [OpenAI公式 ChatKit attachment設定](https://developers.openai.com/api/docs/guides/chatkit-themes#enable-file-attachments)
- [既存実装RAG](https://github.com/kitepon/gpt-connector/blob/main/rag/chatgpt-app/gpt-connector-implementation-20260713.md)
