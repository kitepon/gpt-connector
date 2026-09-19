# Codex単体配送の修理を受け入れる

日付: 2026-09-19

状態: 承認済み・完了

## 判断

gpt-connectorの公式キューと同期hookへの移行を受け入れる。公開版0.9.4の導入・実相談・回答自動配送まで成立し、追加の製品修理や人の操作は不要と判定した。Aitermへの実行時依存は持たない。

## 根拠

- 独立した読み取り専用レビューで、旧Windows binaryの再起動判定漏れと、home消失時の配送状態丸めを特定し、focused test付きで修理した。録音adapterとのclient重複を除く追加修理も実測原因に一致し、通信前の例外伝播に欠陥がないことを確認した。
- lint・型検査、231試験（成功224・対象外skip7）、配送・移行20試験、release gate5試験、MacとWindowsの公式Codex各7条件が成功した。main・tagの3環境CIも成功した。
- main祖先からnpm provenance付きで0.9.4を公開し、3端末へ標準導入した。Mac・WindowsのChat、Linuxの対応範囲の登録・MCPを確認した。
- 最後のMac再起動後、公開MCPの診断とsetupはready。同じ親ターンへ実相談の回答が1回だけ自動配送され、台帳のsubmittedと会話のarchived trueを照合した。

受入結果と公開CIへの参照は[完了記録](../archive/2026-09-19-codex-queue-hooks.md)に保存する。
設計の根拠は[公式キュー・hookの実測](../../rag/chatgpt-app/codex-queue-hooks-20260919.md)、
追加修理の根拠は[API clientの経路照合](../../rag/chatgpt-app/api-client-route-20260919.md)に保存した。
