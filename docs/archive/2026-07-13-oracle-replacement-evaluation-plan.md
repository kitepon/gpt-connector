# dotagents Oracle置換評価計画

作成日: 2026-07-13

状態: 完了・archive済み

> 2026-07-13方針更新: 本書の「text filesをpromptへ展開し、正規uploadを不要とする」部分はオーナー裁定で上書きされた。現行方針は[`2026-07-13-native-file-attachment-plan.md`](2026-07-13-native-file-attachment-plan.md)を正とし、最初にChatGPT正規添付の実現調査を行う。テキスト展開は未採用であり、暗黙fallbackにしない。

## 目的

dotagentsコアの`oracle.consult`を`gpt-connector`へ置き換えられるか、通常Chat transportだけでなくsecond-opinion製品契約と運用まで含めて実物比較する。

## 置換成功条件

- Chat枠でone-shotと同一conversation follow-upが動く。
- model／thinking effortを呼出し側から検証付きで選べる。
- files／globを安全に解決し、長文contextを相談へ渡せる。
- MCP呼出しが長時間実行、timeout、再接続、失敗後の状態確認を扱える。
- 成功時archive、失敗時cleanup、session混線防止が観測できる。
- dotagents側のskill／正典／MCP設定を無理なく移行できる。
- Oracle既知のUI依存、下書き混入、model picker、undici wrapper罠を減らす。

## 理想優先順位

1. `gpt-connector`単独でOracleの公開契約と運用を置換する。
2. `gpt-connector`をtransportとし、dotagents所有の薄いOracle互換adapterを置く。
3. Oracleを維持し、`gpt-connector`は別toolとして併用する。

## TODO

- [x] dotagentsのOracle正典、wrapper、MCP schema、利用箇所を固定する。
- [x] npm global版`gpt-connector@0.1.0`と専用Chromeの前提を再確認する。
- [x] global CLIでmodels、default one-shot、model／effort指定、invalid modelを実測する。
- [x] global MCPでtool schema、one-shot、2turn、close、same-session並行拒否を実測する。
- [x] Oracleをdry-runし、解決configとfiles／follow-up契約を確認する。
- [x] Oracleをfiles＋follow-up付きでlive実測した。300秒でcaller timeout、sessionは継続し、専用Chromeを対象限定TERM後にerror確定。archive成功は確認できなかった。
- [x] 両者の機能、依存面積、failure mode、dotagents移行コストを比較する。
- [x] 重要結論をRAGとINDEXへ還流する。
- [x] 親自身で反対仮説を検証し、置換裁定を確定する。

## 裁定

**dotagents実需要を基準にすると、優先順位1の`gpt-connector`単独置換は実現可能であり、第一選択へ戻す。** Oracle全機能のparityは不要。`gpt-connector`本体へtext files／glob、dry-run、最小job status、factory診断を追加し、移行時だけ`oracle.consult`相当の薄い互換名を提供する。恒久的な別adapter製品は作らない。

現行`0.1.0`のまま即時切替はしない。下記P0とrelease gateを満たした版を作り、shadow実測後にdotagents側を独立waveで移行する。

## dotagents実需要レーン

- [x] dotagents正典、skills、commands、testsからOracleの実消費契約を列挙する。
- [x] Oracle session台帳を本文・file内容・IDなしで集計し、実際に使われた引数を数える。
- [x] 必須／置換後早期／不要の3段階へ分類する。
- [x] gpt-connector 0.1.0の充足状況と最小追加実装を対応付ける。
- [x] Oracleを外せる最小release gateと実装順を確定する。
- [x] 評価RAGとINDEXをdotagents実需要基準へ更新する。
- [x] 親自身で「呼出し側連結で十分」「永続session不要」等の反対仮説を再検証する。

## 実需要の証拠

dotagents正典上のOracleの役割は、ChatGPT Chat枠を使う「実読不要の純推論」「設計意見の別視点」「差分を貼れる規模の第三者レビュー」である。実装物量やリポ全体を読む監査は担当外。

過去30日・評価probeを除くOracle 44 sessionを、prompt本文・file内容・session IDを出さずに集計した。

- filesあり: 26/44（59%）。124 file specは`.md` 55、`.ts` 61、`.tsx` 4、`.mjs` 2、`.diff` 2で、binaryは0。
- thinking time指定あり: 33/44（75%）。extended 26、heavy 5、standard 2。
- planned follow-upあり: 0/44。
- duration: p50 256.8秒、p75 467.3秒、p90 613.5秒。
- status: completed 24、error 20。直近48時間は評価probeを除き3件すべてerrorで、短期標本なので一般化には使わない。

さらに`gpt-connector@0.1.0`で25,774文字の複数text相当を`gpt-5-6-thinking／extended`へ送り、17.0秒で固定応答とarchive成功を確認した。

## 必要度分類

### P0 — Oracle切替前に必須

1. `consult`面: prompt、text files／glob、dry-run、slug、model、effort。`engine`はbrowser固定で、省略または`browser`以外を拒否する。一般利用ではslugを任意にできるが、dotagents標準形ではcaller生成の一意slugを必須にする。
2. text context assembler: 決定的順序、include glob、重複排除、UTF-8検証、秘密pattern除外、総byte上限、文字数／概算token表示。binary uploadは持たない。
3. 明示model／effortとresolved metadata。現行機能を流用し、未指定defaultをdotagentsの決定表用途では使わない。
4. 最小job status: caller timeout後もcaller既知のslugで同じjobを検索し、再送せずterminal result／errorを確認できる。timeout時に裏operationを孤児化しない。本文、cookie、conversation IDは台帳へ保存しない。
5. 成功時archive read-back、失敗時cleanupの結果とerror codeを明示する。
6. `--version`とmachine-readable diagnostics。package version、CDP到達、公式origin、auth、bridge build、open job／operation件数だけを返す。
7. 移行期間だけの互換面: MCP server idを`oracle`のまま`gpt-connector-mcp`へ差し替えられる`consult`／`sessions` tool名。恒久adapter packageは作らない。

### P1 — 置換後早期

- explicit cancelとprogress／heartbeat。
- job台帳のprocess restart回収と保持期限／GCの運用強化。
- text fileのinclude／exclude表現、診断の詳細化。
- 旧`browserThinkingTime`名を使う移行呼出しが残る場合の、明示的な対応表。未知値をfallbackしない。

### 不要 — dotagentsの切替条件にしない

- planned follow-up専用schema。必要なら既存opaque sessionを呼出し側が順次使う。
- binary／ZIP／PDF／image upload、Deep Research、Project Sources。
- API engine、`OPENAI_API_KEY`、model picker DOM操作、browser copy-profile、hide-window shim。
- Oracle全preset、全CLI、全session metadataのバイト互換。

## 実装順

1. **Release A — consult契約とtext context**: `consult`／`sessions` schema、files／glob resolver、dry-run、size／secret gate、契約test。
2. **Release B — 運用回収**: job ID、status/result/error、timeout後の再取得、孤児operation防止、archive／cleanup fault injection。
3. **Release C — 工場統合面**: `--version`、diagnostics JSON、MCP互換名、global install smoke。
4. **Shadow gate**: filesなし／あり、standard／extended／max、timeout／auth loss／runtime drift／restartを代表fixtureで実ブラウザ検証する。Oracleへ自動fallbackしない。
5. **dotagents切替wave**: product contract／factory scan／ServerManager期待schema、agents-update、verify-install、MCP登録、oracle skill、02／05／06正典、wrapper testsを同じ独立waveで更新する。旧Oracle履歴は消さず`not_applicable`遷移を設ける。
6. **Oracle撤去**: 全hostのshadow greenとオーナー承認後にwrapper／package更新対象を外す。rollbackは前releaseのMCP commandへ戻すだけに限定する。

## 最小release gate

- text files／glob付きconsultがdry-runとliveの両方で決定的に動く。
- dotagents代表fixtureでmodel／effortのrequestedとresolvedが一致する。
- caller timeout後、事前指定slugから再送なしで同じjobのterminal result／errorを取得できる。
- 成功・auth失効・runtime drift・timeoutの全経路でconversation／operation残置を検査できる。
- CLI diagnosticsをdotagents factory fixtureがmachine-readableに判定できる。
- 連続10件、うちfilesあり6件・extended以上4件で誤送信、prompt混線、archive漏れが0。
- Oracleへの暗黙fallbackはなく、失敗はgpt-connectorのerrorとして名指しされる。

## 反対仮説の再検証

- **純推論なのでfiles不要**: 実績26/44がfiles付きで棄却。ただし全fileがtextなのでupload parityは不要。
- **呼出し側でtext連結すればよい**: hostごとにglob、秘密除外、上限、順序が分裂するため棄却。resolverはconnector所有が妥当。
- **17秒で終わるのでjob status不要**: live probeは強い肯定材料だが、Oracle実績p90 613.5秒、gpt-connector Pro試験の無出力終了、現実装timeout後にpage operationをcancel／consumeしない構造が残るため、切替ゲートからは外せない。ただし実装順はfilesの後へ下げる。
- **Oracle公開面を全部模倣すべき**: planned follow-up 0、binary 0、programmatic consumerなしのため棄却。dotagents実消費面だけを本体へ入れる。
- **恒久adapterが必要**: tool名互換は移行期だけで足り、別packageは所有境界と診断面を増やすため棄却。

## 外部状態

- 無害probe conversationだけを作成し、完了後archiveする。
- Oracle／dotagentsの設定は変更しない。
- delete、個人conversation操作、通常Chrome profile利用は行わない。
- token、cookie、conversation ID、account IDを保存・出力しない。
