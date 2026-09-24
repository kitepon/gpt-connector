# Grok Webと実測した接続境界

- 出典: [xAI Grok概要](https://docs.x.ai/grok/overview)、[xAI consumer FAQ](https://docs.x.ai/grok/faq)、2026-09-24の専用Chromeでの実測
- 取得日: 2026-09-24
- 確度: 公式Webの提供範囲は高、以下の非公開Web runtimeの形は実測時点に限る

Grokは`grok.com`のconsumer Web Chatを提供する。本製品はAPIキーを使うxAI公開APIではなく、ログイン済み公式Web pageのruntimeを利用する。

実測では公式page内のChat clientで新規会話、同じ会話への追加質問、回答一覧のサーバー読戻し、soft deleteが成立した。別プロセス2本から異なる会話を同時に送り、各回答を識別できた。mode一覧は取得できたが、現在の送信契約は自動modeだけに固定する。添付・画像生成は本版の受入範囲に含めていない。

非公開runtimeのモジュール番号・URL・応答形式は変動するため、製品コードは読み込まれたassetから役割を一意に検出し、不一致なら`RUNTIME_DRIFT`で停止する。
