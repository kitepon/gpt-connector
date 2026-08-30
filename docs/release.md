# Release

gpt-connectorのreleaseはこのrepositoryが所有する。dotagentsは工場統合後のcompatibility確認を行えるが、
version決定、製品gate、npm公開、tag／GitHub Release、公開後smokeの正本ではない。

## Version同期

新versionでは次を同じ値へ更新する。

- `package.json`
- `src/version.ts`
- `README.md`の現行版記載
- `docs/ai-installer-setup-contract.md`のversion指定例
- `CHANGELOG.md`の新version見出しと日付

`pnpm-lock.yaml`はroot package versionを保持しない。依存graphが変わった場合だけ更新する。

同じversionを再公開しない。公開後に欠陥が見つかった場合は次のpatchへ進め、必要なら欠陥版をnpmでdeprecateする。

## Local gate

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm build
corepack pnpm test:release-gate
npm pack --dry-run --json
```

`test:release-gate`はrelease commit gate自体の単体試験である。対象commitを`main`へpushし、4環境のGitHub Actionsがgreenになった後、cleanなworktreeで実gateを確認する。

```bash
git fetch origin
corepack pnpm verify:release-commit
```

`verify:release-commit`はpublish対象が`origin/main`の祖先であり、tracked／untracked差分のないworktreeから
payloadを作ることを要求する。この入口自身が`origin/main`を取得してから判定する。packageの`prepublishOnly`と
tag CIのpublish jobも同じ入口を使う。

## Cloud publish

npmのprovenanceはGitHub ActionsのOIDCから作る。local shellでは`npm publish`を実行しない。
npm Trusted Publisherはrepository `kitepon/gpt-connector`、workflow `.github/workflows/ci.yml`へ設定する。

1. `package.json`と同じversionの`v<version>` tagを、検証済みのmain commitへ付けてpushする。
2. tag起点のCIが4環境のfull gateを再実行する。
3. full gate後、同じworkflowの`publish` jobがtagとpackage version、`origin/main`祖先、pack payloadを検証し、`npm publish --provenance --access public`を実行する。
4. npmに同versionが既に存在する再実行ではpublishだけをskipし、versionを上書きしない。
5. tag CIとnpm registryを確認した後、同じtagへGitHub Releaseを公開する。

```bash
release_version=$(node -p "require('./package.json').version")
release_commit=$(git rev-parse HEAD)
git tag "v$release_version" "$release_commit"
git push origin "v$release_version"
run_id=$(gh run list --workflow ci.yml --commit "$release_commit" --event push --limit 1 --json databaseId --jq '.[0].databaseId')
test -n "$run_id"
gh run watch "$run_id" --exit-status
test "$(npm view "gpt-connector@$release_version" version)" = "$release_version"
gh release create "v$release_version" --target "$release_commit" --generate-notes
```

## 公開後smoke

公開npm packageを公式経路でglobal installし、最低限次を確認する。

```bash
release_version=$(node -p "require('./package.json').version")
npm install --global "gpt-connector@$release_version"
gpt-connector --version
gpt-connector doctor
```

さらにread-only MCP initialize／tools listがstderrを汚さず、7 toolsと0.4.18以降のChatGPT限定
discovery契約を維持することを確認する。Chrome runtimeへ変更があるreleaseだけ、専用profileで
`browser start`、`models`、hidden中の最小Chat、必要時の`browser show`を実行する。

## 巻き戻し

npm versionとtagは移動・上書きしない。利用環境は直前の正常versionを明示installして戻せる。
state schema／migrationを変更したreleaseでは、旧versionへ戻せる条件をCHANGELOGへ明記してから公開する。
