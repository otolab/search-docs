# Changeset利用ガイド

このプロジェクトではバージョン管理とリリースに[Changeset](https://github.com/changesets/changesets)を使用しています。

## Changesetとは

Changesetは、モノレポ内の複数パッケージのバージョン管理とリリースを自動化するツールです。

**主な機能**:
- 変更内容の記録（changesetファイル）
- セマンティックバージョニング（major/minor/patch）
- 依存関係を考慮した自動バージョンアップ
- CHANGELOG.mdの自動生成
- pnpmモノレポでの一括publish

## 基本ワークフロー

### 1. 変更後にchangesetを作成

機能追加やバグ修正などのコード変更を行った後、changesetを作成します。

```bash
pnpm changeset
```

対話形式で以下を入力します：

1. **変更したパッケージを選択**
   - スペースキーで選択（複数可）
   - Enterで確定

2. **バージョンタイプを選択**
   - `major`: 破壊的変更（1.0.0 → 2.0.0）
   - `minor`: 新機能追加（1.0.0 → 1.1.0）
   - `patch`: バグ修正（1.0.0 → 1.0.1）

3. **変更内容の説明を入力**
   - ユーザー向けの変更内容を記述
   - CHANGELOG.mdに掲載される

### 2. changesetファイルをコミット

```bash
git add .changeset/
git commit -m "chore: add changeset for feature X"
```

### 3. リリース時にバージョン更新

全ての変更が完了し、リリース準備ができたら：

```bash
pnpm changeset version
```

このコマンドは：
- 各パッケージのpackage.jsonを更新
- CHANGELOG.mdを生成・更新
- changesetファイルを削除

変更を確認してコミット：

```bash
git add .
git commit -m "chore: version packages"
```

### 4. 公開

```bash
pnpm publish -r --no-git-checks
```

オプション：
- `-r`: モノレポ内の全パッケージを公開
- `--no-git-checks`: Gitの状態チェックをスキップ

## 実例

### 新機能を追加した場合

```bash
# 1. 機能を実装
git add src/new-feature.ts
git commit -m "feat: add new feature X"

# 2. changesetを作成
pnpm changeset
# → @search-docs/cli を選択
# → minor を選択
# → "Add new feature X" と入力

# 3. changesetをコミット
git add .changeset/
git commit -m "chore: add changeset for new feature"

# 4. リリース準備時（全ての変更が完了したら）
pnpm changeset version
git add .
git commit -m "chore: version packages"

# 5. 公開
pnpm publish -r --no-git-checks
```

### バグ修正の場合

```bash
# 1. バグを修正
git add src/fix-bug.ts
git commit -m "fix: resolve issue with X"

# 2. changesetを作成
pnpm changeset
# → 影響を受けたパッケージを選択
# → patch を選択
# → "Fix issue with X" と入力

# 3-5. 上記と同様
```

## Changesetファイルの構造

`.changeset/`ディレクトリに生成されるファイル例：

```markdown
---
"@search-docs/cli": minor
"@search-docs/server": patch
---

Add new feature X

This adds a new command for feature X.
```

## 注意事項

### バージョンタイプの選択基準

- **major**: API破壊、後方互換性のない変更
- **minor**: 新機能追加、後方互換性あり
- **patch**: バグ修正、内部実装の改善

### 依存関係の自動更新

依存しているパッケージのバージョンが上がると、依存元も自動的にバージョンアップされます。

例：
- `@search-docs/types`をminor更新
- `@search-docs/cli`（typesに依存）が自動的にpatch更新

### 複数のchangesetをまとめる

複数の変更がある場合、changesetを個別に作成できます。`pnpm changeset version`時に全てのchangesetがまとめて適用されます。

## トラブルシューティング

### publishに失敗する

```bash
# npmレジストリへのログインを確認
npm whoami

# ログインしていない場合
npm login
```

### バージョンが意図通りに上がらない

- changesetファイルの内容を確認
- 依存関係を確認（依存パッケージの変更が影響している可能性）

## 参考リンク

- [Changeset公式ドキュメント](https://github.com/changesets/changesets)
- [pnpmワークスペースとの統合](https://pnpm.io/using-changesets)
