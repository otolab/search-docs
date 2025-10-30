# Task 6: 設計と実装の乖離調査と修正

## 背景

`index rebuild`コマンドの実装中に、以下の問題が発見されました：

1. **問題A**: dbPath解決エラー（Python workerのcwd問題） → **修正済み**
2. **問題B**: rebuild重複問題（削除ロジックの不備） → **修正済み**
3. **問題C**: 設計と実装の乖離（Dirtyマーキングシステム未実装） → **要対応**

この文書では、**問題C**について詳細に記録します。

## 問題の発見経緯

### ユーザーからの質問

1. "その設定ファイルはどこから生えてきたのですか？"
   - `.search-docs.json`の作成根拠が不明
   - 設計書に記載がない

2. "rebuildを繰り返したらindexが再生成される問題は別に解決が必要"
   - DocumentStorageとSearchIndexの整合性問題

3. "「document, index」の整合性管理の方針の根本について疑いを持っている。方針は文書化されているか？"
   - 整合性管理の設計と実装が一致しているか

### 調査結果

設計書（`docs/data-model.md`）には、以下の整合性管理方針が明記されています：

#### 設計書の記載（data-model.md:181-199）

```
### 文書追加・更新時
1. DocumentStorageに文書を保存
   - path, content, metadataを保存
   - 文書のハッシュを計算

2. 既存の分割データをチェック
   - document_pathで検索
   - 文書ハッシュが異なる場合、is_dirty=trueにマーク

3. バックグラウンドで分割・インデックス処理
   - Markdown解析
   - トークン数計測
   - 再帰的分割
   - ベクトル化
   - SearchIndexに保存（is_dirty=false）

4. 古いDirtyデータを削除

### Dirty更新プロセス
1. is_dirty=trueのレコードを取得（古い順）
2. 対応する文書をDocumentStorageから取得
3. 再分割・再ベクトル化
4. SearchIndexを更新（is_dirty=false）
5. 次のDirtyデータへ
```

#### 実装の実態（search-docs-server.ts:143-190）

```typescript
async indexDocument(request: IndexDocumentRequest): Promise<IndexDocumentResponse> {
  // 1. ファイル読み込み
  const content = await fs.readFile(path, 'utf-8');

  // 2. ハッシュ計算
  const hash = createHash('sha256').update(content).digest('hex');

  // 3. 既存文書をチェック
  const existingDoc = await this.storage.get(path);
  if (existingDoc && existingDoc.metadata.fileHash === hash && !force) {
    return { success: true, sectionsCreated: 0 };
  }

  // 4. Markdown分割
  const sections = this.splitter.split(content, path, hash);

  // 5. 既存セクションを削除（★問題B修正後）
  await this.dbEngine.deleteSectionsByPath(path);

  // 6. 文書をストレージに保存
  await this.storage.save(path, document);

  // 7. セクションをDBに追加
  for (const section of sections) {
    await this.dbEngine.addSection(section);
  }

  return { success: true, sectionsCreated: sections.length };
}
```

### 乖離の内容

| 項目 | 設計書 | 実装 |
|------|--------|------|
| **更新方式** | Dirtyマーキング + 非同期更新 | 同期的な削除→追加 |
| **is_dirtyフィールド** | 使用する | 使用していない |
| **バックグラウンドワーカー** | あり（時間差前提） | なし |
| **古いデータの扱い** | Dirtyマークして後で削除 | 即座に削除 |
| **整合性保証** | 最終的整合性 | 即座の整合性 |

## 問題の影響

### 現在の実装の問題点

1. **パフォーマンス**
   - 大量文書の更新時、すべて同期的に処理される
   - ベクトル化が重い処理のため、レスポンスが遅い

2. **設計意図との不一致**
   - Dirtyマーキングシステムの実装が前提となっている箇所が機能しない
   - `is_dirty`フィールドが常にfalse

3. **拡張性**
   - バックグラウンドワーカーを追加する余地がない
   - 段階的な更新ができない

### 問題B修正の効果

問題Bの修正（`deleteSectionsByPath`を常に実行）により：

- ✅ rebuild時の重複は解消される
- ✅ DocumentStorageとSearchIndexの不一致にロバストになる
- ❌ 設計書との乖離は解消されない
- ❌ パフォーマンス問題は残る

## 対応方針の選択肢

### Option 1: 設計書に従ってDirtyマーキングシステムを実装

**利点**:
- 設計意図に忠実
- パフォーマンス向上（バックグラウンド処理）
- 最終的整合性による柔軟性

**欠点**:
- 実装コストが高い
- バックグラウンドワーカーの管理が複雑
- テストが難しい

**必要な作業**:
1. `is_dirty`フィールドの活用
2. `markDirty()`の実装（既に存在）
3. バックグラウンドワーカーの実装
4. `getDirtySections()`の活用
5. 段階的更新ロジックの実装

### Option 2: 設計書を更新して現在の実装に合わせる

**利点**:
- 実装コストが低い
- シンプルで理解しやすい
- テストが容易

**欠点**:
- パフォーマンス問題が残る
- 大量文書の更新に不向き
- 拡張性が低い

**必要な作業**:
1. `docs/data-model.md`の更新
2. Dirtyマーキング関連のAPIを削除または非推奨化
3. 設計意図の見直し

### Option 3: ハイブリッドアプローチ

**利点**:
- 段階的に移行可能
- リスクが低い

**欠点**:
- 設計が複雑になる
- 2つのパスが並存する期間がある

**必要な作業**:
1. デフォルトは同期的な削除→追加
2. オプショナルでDirtyマーキングを使えるようにする
3. パフォーマンスが必要な場面でDirtyマーキングを選択

## DBエンジンのAPI

既にDirtyマーキング関連のAPIは実装済みです：

```typescript
// packages/db-engine/src/typescript/index.ts
async markDirty(documentPath: string): Promise<{ marked: boolean }>
async getDirtySections(limit: number = 100): Promise<{ sections: Section[] }>
```

```python
# packages/db-engine/src/python/worker.py
def mark_dirty(self, params: Dict[str, Any]) -> Dict[str, int]
def get_dirty_sections(self, params: Dict[str, Any]) -> Dict[str, List]
```

## 次のステップ

### 即座に必要な対応

1. ✅ **問題A修正**: dbPath解決エラー
2. ✅ **問題B修正**: rebuild重複問題
3. **問題C対応**: 方針決定

### 方針決定のための質問

1. **パフォーマンス要件**
   - 大量文書（1000+）のインデックス更新は想定されるか？
   - リアルタイム性は必要か、バックグラウンド処理で良いか？

2. **実装優先度**
   - 早期リリースを優先するか？
   - 設計の完全性を優先するか？

3. **将来の拡張性**
   - Git連携など、外部システムとの統合は想定されるか？
   - スケーラビリティは重要か？

## 設定ファイルの問題

ユーザーからの質問「その設定ファイルはどこから生えてきたのですか？」について：

### 調査結果

```bash
$ git log --all --oneline --source --remotes -- .search-docs.json
3cae0a0 (HEAD -> main) feat(cli): index rebuild コマンドを実装
```

- `.search-docs.json`は assistant が commit 3cae0a0 で作成
- 設計書（`docs/client-server-architecture.md`）には設定ファイルの**フォーマット**は記載されている
- しかし、**誰が、いつ、どのように作成するか**の仕様は記載されていない

### 設定ファイル作成の仕様化が必要

以下を明確にする必要があります：

1. **作成タイミング**
   - `search-docs config init`コマンドで作成？
   - サーバ初回起動時に自動生成？
   - 手動作成を前提？

2. **デフォルト値**
   - どのような値をデフォルトとするか
   - プロジェクトタイプ（Node.js, Python等）による違い

3. **配置場所**
   - `.search-docs/config.json` vs `.search-docs.json`
   - どちらを優先するか

## まとめ

3つの独立した問題を発見：

- **問題A**: 技術的な実装ミス（Python workerのcwd） → **修正済み**
- **問題B**: ロジックの不備（削除条件の不足） → **修正済み**
- **問題C**: アーキテクチャの乖離（設計 vs 実装） → **方針決定待ち**

問題Cは単なるバグ修正ではなく、**設計方針の根本的な見直し**が必要な問題です。

---

**作成日**: 2025-10-29
**ステータス**: 調査完了、方針決定待ち
**関連ファイル**:
- `docs/data-model.md`
- `packages/server/src/server/search-docs-server.ts`
- `packages/db-engine/src/typescript/index.ts`
- `packages/db-engine/src/python/worker.py`
