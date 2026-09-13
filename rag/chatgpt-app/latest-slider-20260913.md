# 通常Chatの「最新」と右端の選択

出典: [公式runtimeの取得記録](raw/latest-slider-20260913.md)、製品MCPの実測、利用者が示したWebの操作。
取得日: 2026-09-13。確度: preset定義と実行結果で確認。モデル世代と段階名は取得時点の観測値。

旧実装は通常Chatのmodelとthinking_effortsだけを公開し、Webのスライダーを表すversionsのintelligence_presetsを捨てていた。default_model_slugへ委ねる処理も、最新の右端を選ぶ要求に一致していなかった。

「最新」の配列順は次のとおり。IDの大小は並び順ではない。

| 位置 | ID | 段階 | model | thinking_effort |
| --- | --- | --- | --- | --- |
| 1 | 0 | Instant | gpt-5-6-instant | なし |
| 2 | 1 | 中程度 | gpt-5-6-thinking | standard |
| 3 | 2 | 高 | gpt-5-6-thinking | extended |
| 4 | 6 | 極高 | gpt-5-6-thinking | max |
| 5 | 3 | Pro | gpt-6-pro | なし |

Proのraw model一覧にはeffortが載る場合があるが、このpresetにはない。スライダーの再現ではpresetの省略を保ち、任意のeffortを補わない。通常Chatの会話modeはprimary_assistantで、Work-only modelは除外する。

実装はモデルslugを固定せず、呼出し時のlatest presetを解決する。右端が利用不可なら停止する。保存済みconsultの取得には新たなmodel解決を挟まない。GPTの修正レビューがこの処理順の不備を指摘し、catalog変更前後の再取得と再送ゼロをfocused testで確認した。

この記録は履歴。利用時は製品の[公開契約](../../README.md)とlive catalogを参照する。

0.6.0の製品MCPを新規processで起動し、5段階をそれぞれ送信した。すべてfinished_successfully／endTurn=trueで、上表のmodel／effortへ一致した。明示Proの応答は37.7秒。指定を省略したconsultもgpt-6-pro／effort=nullで成功し、archived=trueを確認した。7 toolsの公開schemaにはlevelがあり、stderrへの出力はなかった。
