# Task 6: 設計と実装の乖離調査 - 完了報告

> **🔒 この文章はFIXEDです (2025-11-04)**
> 以降の修正は注釈追記のみ許可されます

**作成日**: 2025-10-29
**完了日**: 2025-10-30
**タスク番号**: task6
**状態**: 調査完了、問題Cは Task 8 へ引き継ぎ

## 概要

`index rebuild`コマンドの実装中に発見された3つの問題について調査し、対応方針を決定した。

## 発見された問題

### 問題A: dbPath解決エラー（Python workerのcwd問題）

**状況**:
- LanceDBデータが `packages/db-engine/.search-docs/index/` に保存される
- 期待される場所: プロジェクトルート `.search-docs/index/`

**原因**:
- Python workerがカレントディレクトリ（`packages/db-engine/`）を基準にパスを解決
- TypeScript側から絶対パスが渡されていない

**対応**: ✅ **修正済み**（Task 7で検証待ち）

**修正内容**:
1. Python worker (worker.py)
   - `--db-path` 引数を受け取る `_get_db_path()` メソッドを追加
   - `main()` で引数から db_path を取得

2. TypeScript DBEngine (db-engine/index.ts)
   - `dbPath` を絶対パスに解決
   - `--db-path=${absoluteDbPath}` を Python worker の引数に追加

3. Server エントリポイント (server/bin/server.ts)
   - `config.project.root` を絶対パスに解決してから `dbPath` を計算

**関連ファイル**:
- `packages/db-engine/src/typescript/index.ts`
- `packages/db-engine/src/python/worker.py`
- `packages/server/src/bin/server.ts`

### 問題B: rebuild重複問題（削除ロジックの不備）

**状況**:
- `index rebuild` を繰り返すと、同じセクションが複数作成される
- DocumentStorageとSearchIndexの整合性が崩れる

**原因**:
- `indexDocument()` で既存セクションの削除が条件付きだった
- ハッシュが同じ場合は削除せず、新しいセクションを追加していた

**対応**: ✅ **修正済み**

**修正内容**:
```typescript
// 修正前
if (existingDoc && existingDoc.metadata.fileHash === hash && !force) {
  return { success: true, sectionsCreated: 0 };
}
// 既存セクションの削除は条件付き

// 修正後
await this.dbEngine.deleteSectionsByPath(path); // 常に削除
```

**効果**:
- rebuild時の重複が解消
- DocumentStorageとSearchIndexの不一致にロバストになる

**関連ファイル**:
- `packages/server/src/server/search-docs-server.ts`

### 問題C: 設計と実装の乖離（Dirtyマーキングシステム未実装）

**状況**:
設計書（`docs/data-model.md`）と実装が乖離している。

**設計書の方針**:
- Dirtyマーキング + 非同期更新
- バックグラウンドワーカーでの処理
- 最終的整合性

**実装の実態**:
- 同期的な削除→追加
- is_dirtyフィールドを使用していない
- バックグラウンドワーカーなし
- 即座の整合性

**対応方針の検討**:

3つの選択肢を検討：
1. **Option 1**: Dirtyマーキングシステムを実装（設計に忠実、高コスト）
2. **Option 2**: 設計書を更新（現実装に合わせる、低コスト）
3. **Option 3**: ハイブリッドアプローチ（段階的移行）

**決定**: ✅ **Task 8として切り出し、仕様を策定**

**理由**:
- 単純なDirtyマーキングではなく、より堅牢な設計が必要
- IndexRequestテーブルを導入した新しいアーキテクチャを採用
- 詳細な仕様策定と実装計画が必要

## Task 6の成果

### 1. 問題の特定と分類

3つの独立した問題を明確に分離：
- **問題A**: 技術的な実装ミス
- **問題B**: ロジックの不備
- **問題C**: アーキテクチャの乖離

### 2. 問題A・Bの修正

即座に修正可能な問題は修正を完了。

### 3. 問題Cの深掘り

設計と実装の乖離を詳細に分析し、以下を明確化：
- 要求事項の整理
- 設計上の課題の抽出
- より良い設計の方向性の提示

### 4. Task 8への引き継ぎ

問題Cについて、新しいアーキテクチャ（IndexRequestテーブル導入）を提案し、Task 8として仕様策定を完了。

## 関連タスク

- **Task 7**: 問題Aの検証（dbPath修正の動作確認）
- **Task 8**: 問題Cの解決（IndexRequest導入による新アーキテクチャ実装）

## 関連ファイル

### 調査・報告
- `prompts/tasks/task6.design-implementation-divergence.v1.md` - 詳細調査報告

### 修正したファイル（問題A）
- `packages/db-engine/src/typescript/index.ts`
- `packages/db-engine/src/python/worker.py`
- `packages/server/src/bin/server.ts`

### 修正したファイル（問題B）
- `packages/server/src/server/search-docs-server.ts`

### 設計書
- `docs/data-model.md` - 元の設計書

## 次のステップ

### 優先度: 高
1. **Task 7**: 問題Aの検証（30分〜1時間）
   - データが正しい場所に保存されているか確認

### 優先度: 中
2. **Task 8**: 問題Cの実装（推定17時間）
   - IndexRequestテーブルの実装
   - IndexWorkerの実装
   - 検索ロジックの更新

## まとめ

Task 6は**調査タスク**として完了しました。

- ✅ **問題A**: 修正完了（検証待ち）
- ✅ **問題B**: 修正完了
- ✅ **問題C**: 仕様策定完了（Task 8で実装待ち）

Task 6で発見された問題は、それぞれ適切に対処方針が決定され、次のアクションが明確になりました。

---

**最終更新**: 2025-10-30
**状態**: 調査完了
**引き継ぎタスク**: Task 7（検証）、Task 8（実装）
