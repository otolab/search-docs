# 未完了タスク一覧

このファイルには、現在未完了または保留中のタスクをまとめています。

**最終更新**: 2025-10-30

---

## 🚀 アクティブタスク

現在進行中のタスクはありません。

---

## ✅ 完了タスク

### Task 9: MCP Server実装

**完了報告**: task9.completion-report.md
**状態**: 完了 ✅
**実装工数**: 約2時間
**完了日**: 2025-10-30

#### 実装内容

- [x] MCP Serverパッケージ作成
- [x] 3つのツール実装（search, get_document, index_status）
- [x] E2Eテスト作成（22テスト全て成功）
- [x] README.md作成

---

## ✅ 完了タスク（過去分）

### Task 8: インデックス状態管理システムの実装

**仕様書**: task8.dirty-marking-system-spec.v2.md
**状態**: 完了 ✅
**実装工数**: 約12時間
**完了日**: 2025-10-30

#### 実装内容

- [x] Phase 1-7: 全て完了
- [x] サーバ起動時の自動インデックス同期機能
- [x] rebuildIndexのスマートリビルド対応
- 合計141テスト全てパス ✅

---

## 📋 保留タスク

### Task 7: dbPath修正の検証（保留）

**元ファイル**: task7.verify-dbpath-fix.v1.md（削除済み）
**状態**: 保留（検証は必要に応じて実施）
**関連**: Task 6（問題A修正）

#### 目的

Task 6で実施したdbPath問題（問題A）の修正が正しく動作しているか検証する。

#### 背景

Task 6で以下の修正を実施：

**実施した修正**:
1. **Python worker (worker.py)** - `--db-path` 引数を受け取る
2. **TypeScript DBEngine (db-engine/index.ts)** - 絶対パスを渡す
3. **Server エントリポイント (server/bin/server.ts)** - パス解決

**期待される動作**:
- LanceDB データは `.search-docs/index/` (プロジェクトルート) に保存される

#### 検証手順（必要時に実施）

```bash
# 1. クリーンな状態から開始
rm -rf .search-docs/ packages/db-engine/.search-docs/

# 2. サーバを起動
node packages/cli/dist/index.js server start

# 3. インデックス作成
node packages/cli/dist/index.js index rebuild AGENTS.md

# 4. データの保存場所を確認
find . -name "*.lance" -type d 2>/dev/null | grep -v node_modules
```

**期待される出力**:
```
./.search-docs/index/sections.lance  # ← プロジェクトルート
```

---

## 優先度: 低

### Task 4（残り）: CLIコマンドの未実装部分

**完了報告**: task4.completion-report.md
**状態**: Phase 3完了、Phase 4/5は部分実装

#### 未実装コマンド

**Phase 4: indexコマンド（部分）**
- ❌ `index status` - インデックス統計を表示（推定: 1時間）
- ❌ `index clean` - Dirtyセクションをクリーン（推定: 1時間）

**Phase 5: configコマンド（全て）**
- ❌ `config init` - デフォルト設定ファイル生成（推定: 2時間）
- ❌ `config validate` - 設定ファイルのバリデーション（推定: 1.5時間）
- ❌ `config show` - 設定ファイルの内容を表示（推定: 0.5時間）

#### 実装の必要性

現状でも基本的な運用（サーバ起動・停止・検索・インデックス再構築）は可能なため、優先度は低い。

---

## その他の検討事項

### 設定ファイルの作成タイミング

**問題**: `.search-docs.json`の作成根拠が不明確
- 誰が、いつ、どのように作成するか仕様化されていない

**対応候補**:
1. `config init`コマンドで作成（未実装）
2. サーバ初回起動時に自動生成
3. 手動作成を前提（ドキュメント整備）

**優先度**: 低（現状は手動作成で運用可能）

---

## タスクの優先順位

1. **Task 8（実装中）** - 17時間
   - インデックス状態管理システムの実装

2. **Task 7（保留）** - 30分〜1時間
   - 必要に応じて検証を実施

3. **Task 4残り（低優先度）** - 5〜7時間
   - 必要に応じて実装

---

**管理ポリシー**:
- このファイルは定期的に見直し、完了したタスクは削除する
- 新しい未完了タスクが発生した場合、このファイルに追記する
- 優先度は状況に応じて随時更新する
