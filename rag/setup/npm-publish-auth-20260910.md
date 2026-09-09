# npm公開認証と製品gateを分けて調べる

- 出典: [npm trust公式](https://docs.npmjs.com/cli/v11/commands/npm-trust/)、[公式原文抜粋](raw/npm-trust-20260910.md)、[製品CI実測](https://github.com/kitepon/gpt-connector/actions/runs/34374479045)
- 取得日: 2026-09-10
- 確度: CLI仕様は公式資料、エラーは実測。今回のTrusted Publisher設定値は未確認

`npm trust list <package>`で公開元設定を照会できる。変更にはpackageへのwrite権限とaccountの2FAが必要。
既存の公開元を確認してから、repository・workflow・任意environment・publish許可を比較する。推測で設定を置換しない。

gpt-connector 0.5.2ではMac・Linux・Windowsとrelease commit gateが通り、provenanceの署名にも成功したが、
registryへのPUTはE404で拒否された。package自体は存在し、公開版の読取りは成功した。
ローカルのtrust listはE401、WebはSign Inへ遷移したため、まず所有者のログインが必要だった。
署名成功をnpm公開成功へ読み替えず、認証エラーを製品コード変更で隠さない。
