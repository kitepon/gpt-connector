# Grok Webと実測した接続境界

- 出典: [xAI Grok概要](https://docs.x.ai/grok/overview)、[xAI consumer FAQ](https://docs.x.ai/grok/faq)、2026-09-24の専用Chromeでの実測
- 取得日: 2026-09-24
- 確度: 公式Webの提供範囲は高、以下の非公開Web runtimeの形は実測時点に限る

Grokは`grok.com`のconsumer Web Chatを提供する。本製品はAPIキーを使うxAI公開APIではなく、ログイン済み公式Web pageのruntimeを利用する。

実測では公式page内のChat clientで新規会話、同じ会話への追加質問、回答一覧のサーバー読戻し、soft deleteが成立した。別プロセス2本から異なる会話を同時に送り、各回答を識別できた。mode一覧にはauto・fast・expert・heavy・buildがある。buildは別機能なのでChat送信には使わない。添付・画像生成は本版の受入範囲に含めていない。

回答のサーバー読戻しでは、assistant responseの`requestMetadata`に`model: grok-4-auto`、`mode: MODEL_MODE_AUTO`、`effort: LOW`が記録されていた。page storeの`activeModelId`は`grok-3`、response直下の`model`も`grok-3`であり、送信要求のモデルIDとは異なる。`metadata.llm_info.modelHash`は不透明なhashだけだった。このため`grok-4-auto`を回答に記録されたモデルIDとして返し、自動modeが内部で選んだ具体的なモデルとは扱わない。具体モデルの値は`null`とする。effortは回答の`requestMetadata`から読む。

非公開runtimeのモジュール番号・URL・応答形式は変動するため、製品コードは読み込まれたassetから役割を一意に検出し、不一致なら`RUNTIME_DRIFT`で停止する。

送信関数は`modelMode`引数よりも共有pageの`selectedModeId`を優先して要求に入れる。`selectedModeId`をfastへ一時変更し、送信関数を呼んだ直後にautoへ戻した試行では、サーバーの回答記録は`MODEL_MODE_FAST`となり、page選択はautoのままだった。送信関数の初期同期区間でmodeを読み込むことに依存するため、回答記録のmodeも要求ごとに照合する。

Windowsの公開版0.12.1では、画面上でGrokへログインした後、SSH経由の`grok-doctor`が`ready`を返した。`expert`の短文Chatは`WINDOWS_EXPERT_OK`、`requestedMode=expert`、`reportedModel=grok-4`、`resolvedEffort=high`で成功した。`auto`の短文Chatは`WINDOWS_AUTO_OK`、`requestedMode=auto`、`reportedModel=grok-4-auto`、`resolvedEffort=low`で成功した。両方とも`resolvedModel=null`で、内部の具体モデルを推定していない。
