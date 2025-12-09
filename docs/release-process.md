# リリースプロセス

このドキュメントでは、search-docsのリリース手順について説明します。

## 概要

search-docsは、GitHub Actionsによる**完全自動化されたリリースフロー**を採用しています。
手動でバージョン更新コマンドを実行する必要はありません。

## リリースフロー

### 1. Changesetの作成（機能追加・修正時）

新機能やバグ修正のPRを作成する際、changesetファイルを追加します。

```bash
# 機能ブランチで実行
pnpm changeset
```

対話形式で以下を設定：
- 影響を受けるパッケージを選択
- バージョンアップの種類を選択：
  - `patch`: バグ修正、小さな改善（1.4.3 → 1.4.4）
  - `minor`: 新機能追加（1.4.3 → 1.5.0）
  - `major`: 破壊的変更（1.4.3 → 2.0.0）
- 変更内容の説明を記述

これにより `.changeset/` ディレクトリに changesetファイルが作成されます。
このファイルを機能ブランチにコミットし、PRに含めてください。

### 2. リリースブランチの作成

PRがmainブランチにマージされた後、リリースを行う準備ができたら：

```bash
# mainブランチから最新を取得
git checkout main
git pull

# リリースブランチを作成（バージョン番号を指定）
git checkout -b release/X.Y.Z

# リリースブランチをプッシュ
git push -u origin release/X.Y.Z
```

**重要**: ブランチ名は必ず `release/` で始まり、バージョン番号（例: `1.4.4`）を含める必要があります。

### 3. GitHub Actionsによる自動処理

`release/` ブランチをプッシュすると、自動的に以下が実行されます：

#### ① Release Prepare ワークフロー（`.github/workflows/release-prepare.yml`）

1. 依存関係のインストールとビルド
2. **`pnpm changeset version` の自動実行**
   - 各パッケージの `package.json` のバージョンを更新
   - `CHANGELOG.md` を自動生成
   - changesetファイルを削除
3. ルート `package.json` のバージョンをブランチ名から更新
4. 変更を自動コミット: `chore: version packages to vX.Y.Z`
5. mainブランチへのPRを自動作成: `Release vX.Y.Z`

### 4. リリースPRのマージ

GitHub上で自動作成されたリリースPRをレビューし、マージします。

**確認項目**:
- 各パッケージのバージョンが正しく更新されているか
- CHANGELOGの内容が適切か
- ルート `package.json` のバージョンが正しいか

### 5. 公開処理の自動実行

リリースPRがマージされると、自動的に以下が実行されます：

#### ② Release Publish ワークフロー（`.github/workflows/release-publish.yml`）

1. GitHubリリースの作成（タグ: `vX.Y.Z`）
2. npmへの公開
   - `@search-docs/types` を最初に公開（依存関係順）
   - その他のパッケージを公開
   - npm Trusted Publishing（provenance）を使用

## ⚠️ 重要な注意事項

### やってはいけないこと

1. **手動で `pnpm changeset:version` を実行しない**
   - GitHub Actionsが自動で実行します
   - 手動実行すると、ワークフローと競合します

2. **リリースブランチで直接コミットしない**
   - GitHub Actionsが自動的にコミットを作成します
   - 手動コミットは避けてください

3. **mainブランチに直接バージョン更新をコミットしない**
   - 必ずリリースブランチ経由で行います

### やるべきこと

1. **changesetファイルは機能ブランチに含める**
   - PRマージ前に changeset を作成
   - `.changeset/` ディレクトリのファイルをコミット

2. **リリースブランチ名は正確に**
   - 形式: `release/X.Y.Z`（例: `release/1.4.4`）
   - バージョン番号は次にリリースするバージョンを指定

3. **リリースPRの内容を確認**
   - 自動生成されたPRの変更内容を必ずレビュー
   - 問題があれば、リリースブランチを削除してやり直し

## トラブルシューティング

### リリースをやり直したい場合

1. リリースブランチとPRを削除：
   ```bash
   # ローカルブランチを削除
   git checkout main
   git branch -D release/X.Y.Z

   # リモートブランチを削除
   git push origin --delete release/X.Y.Z

   # GitHub上でPRをクローズ
   ```

2. 新しいリリースブランチを作成してプッシュ

### changesetが反映されない

- `.changeset/` ディレクトリにchangesetファイルが存在するか確認
- ファイルのフォーマットが正しいか確認
- mainブランチに最新の変更がマージされているか確認

### npm公開に失敗した

- npm Trusted Publishingの設定を確認
- パッケージ名の重複がないか確認
- npmレジストリの状態を確認

## バージョン管理ツール

### Changesets

- 公式ドキュメント: https://github.com/changesets/changesets
- モノレポ対応のバージョン管理ツール
- 各パッケージの独立したバージョン管理が可能

### セマンティックバージョニング

- `MAJOR.MINOR.PATCH` 形式（例: 1.4.4）
- MAJOR: 破壊的変更
- MINOR: 後方互換性のある機能追加
- PATCH: 後方互換性のあるバグ修正

詳細: https://semver.org/lang/ja/

## 参考

- [.github/workflows/release-prepare.yml](../.github/workflows/release-prepare.yml)
- [.github/workflows/release-publish.yml](../.github/workflows/release-publish.yml)
- [.changeset/config.json](../.changeset/config.json)
