# 階層的コンテンツとベクトル検索の課題

## 日付
2025-01-27

## 問題の概要

現在の実装では、各セクションが**独立したコンテンツのみ**を持っており、階層的な意味構造が検索時に失われる問題がある。

## 現在の実装の問題点

### 1. 親セクションは子のコンテンツを含まない

**現在の実装**:
```typescript
// markdown-splitter.ts
private buildContent(node: HeadingNode): string {
  let text = '';

  // 見出しを追加
  if (node.heading) {
    const prefix = '#'.repeat(Math.max(1, node.depth));
    text += `${prefix} ${node.heading}\n\n`;
  }

  // コンテンツを追加（子のコンテンツは含まれない）
  text += node.content.join('\n\n');

  return text.trim();
}
```

**問題**:
- H1セクションには、その下のH2, H3のコンテンツが含まれない
- 各セクションが断片的な情報のみを持つ

### 2. depth=0は前文のみ

**現在の実装**:
```typescript
// depth 0は「見出しのない前文」のみ
if (contentBuffer.length > 0) {
  currentDepth0 = {
    depth: 0,
    heading: '',
    content: contentBuffer, // 前文のみ
    children: [],
  };
}
```

**問題**:
- depth=0が文書全体を表していない
- 文書全体のコンテキストでの検索ができない

### 3. コンテキスト情報の欠如

**現在の実装**:
```typescript
const section: Omit<Section, 'vector'> = {
  id,
  documentPath,
  heading: node.heading,
  depth: node.depth,
  content, // 断片的なコンテンツのみ
  // ...
  metadata: {
    documentHash,
    createdAt: now,
    updatedAt: now,
    summary: undefined,        // 将来的に追加予定
    documentSummary: undefined, // 将来的に追加予定
  },
};
```

**問題**:
- セクション単体では「何についての情報か」が分からない
- 例: "インストール手順"というセクションがあっても、「何のインストール手順か」が不明

## 具体例

### Markdownファイル例
```markdown
# Node.js プロジェクトのセットアップガイド

このガイドでは、Node.jsプロジェクトの初期セットアップ方法を説明します。

## インストール手順

### 前提条件
Node.js 18以上が必要です。

### パッケージのインストール
```
npm install
```

## 使用方法
サーバーを起動するには...
```

### 現在の分割結果（問題あり）

| depth | heading | content | ベクトル化される内容 |
|-------|---------|---------|-------------------|
| 0 | (document root) | "このガイドでは..." | "このガイドでは..." のみ |
| 1 | Node.js プロジェクト... | "# Node.js...\n\nこのガイドでは..." | H1見出しと前文のみ（子の内容なし） |
| 2 | インストール手順 | "## インストール手順" | 見出しのみ（具体的な手順が含まれない） |
| 3 | 前提条件 | "### 前提条件\n\nNode.js 18以上..." | この部分のみ |
| 3 | パッケージのインストール | "### パッケージの...\n\nnpm install" | この部分のみ |
| 2 | 使用方法 | "## 使用方法\n\nサーバーを..." | この部分のみ |

### 検索時の問題

**クエリ**: "Node.jsプロジェクトのnpmインストール方法"

**期待される挙動**:
- 文書全体（depth=0相当）: "Node.jsプロジェクトのセットアップガイド" にマッチ
- H1レベル: "Node.js プロジェクトのセットアップガイド" にマッチ
- H2レベル: "インストール手順" にマッチ
- H3レベル: "パッケージのインストール" にマッチ

**実際の挙動**:
- depth=0: "このガイドでは..." だけで、"Node.js"や"npm"が含まれない可能性
- H1: 子セクションの内容が含まれないため、"npm install"に直接マッチしない
- H2: "インストール手順"という見出しのみで、具体的な手順が含まれない

## 必要な要件

### 1. マクロ・ミクロの両面での意味保持

各depthレベルで完全な意味を持つ必要がある:

- **depth=0（文書全体）**: README.md全体としての意味
- **depth=1（章）**: 章全体としての意味（節の内容を含む）
- **depth=2（節）**: 節全体としての意味（小節の内容を含む）
- **depth=3（小節）**: 小節単体の意味

### 2. 階層的コンテンツの包含

親セクションは子セクションのコンテンツを**すべて含む**べき:

```
depth=0: 文書全体のコンテンツ
  ├─ depth=1: H1 + その下のH2, H3すべて
  │   ├─ depth=2: H2 + その下のH3すべて
  │   │   └─ depth=3: H3のみ
  │   └─ depth=2: H2 + その下のH3すべて
  └─ depth=1: H1 + その下のH2, H3すべて
```

### 3. コンテキスト情報の付加

各セクションには以下の情報が必要:

- **セクション自体のコンテンツ**: ベクトル化される主要コンテンツ
- **文書全体のサマリ**: "このセクションは〇〇についての文書の一部"というコンテキスト
- **親セクションのパス**: 階層的なコンテキスト情報

### 4. ベクトル化戦略

**単一ベクトルアプローチ（採用）**:

コンテンツ自体にサマリと階層情報を含める形で、単一のベクトルで検索可能にする:

```typescript
// contentフィールドにすべての情報を含める
content: `
Document: Node.jsプロジェクトのセットアップガイド
このガイドでは、Node.jsプロジェクトの初期セットアップ方法を説明します。

---

## インストール手順

### 前提条件
Node.js 18以上が必要です。

### パッケージのインストール
\`\`\`
npm install
\`\`\`
`
```

**構造**:
```
[文書サマリ]
[文書の前文（あれば）]

---

[セクションのコンテンツ（子セクションを含む）]
```

**メリット**:
- 単一ベクトルで完全な意味を保持
- コンテキストが自然言語として含まれる
- ベクトル検索が正確に機能する
- 実装がシンプル

**デメリット**:
- トークン数が増加する
- サマリ生成にLLMが必要（Phase 2）

**Phase 1での対応**:
- サマリなしで階層的コンテンツのみ実装
- Phase 2でサマリを追加

## 提案する解決策

### Phase 1: 階層的コンテンツの実装（短期）

`markdown-splitter.ts`を修正し、親セクションに子のコンテンツを含めるようにする:

```typescript
private buildContent(node: HeadingNode, includeChildren: boolean = true): string {
  let text = '';

  // 見出しを追加
  if (node.heading) {
    const prefix = '#'.repeat(Math.max(1, node.depth));
    text += `${prefix} ${node.heading}\n\n`;
  }

  // 自分のコンテンツを追加
  text += node.content.join('\n\n');

  // 子のコンテンツを再帰的に追加
  if (includeChildren && node.children.length > 0) {
    for (const child of node.children) {
      text += '\n\n' + this.buildContent(child, true);
    }
  }

  return text.trim();
}
```

**depth=0の修正**:
```typescript
// depth=0は文書全体
const rootNode: HeadingNode = {
  depth: 0,
  heading: '', // または文書タイトル
  content: contentBuffer, // 前文
  children: nodes, // すべてのH1セクション
};

const rootSection = this.buildSections([rootNode], documentPath, documentHash)[0];
```

**トークン数制限への対処**:
- maxTokensPerSectionを超える場合は警告
- または、トークン数に応じて子の含め方を調整（サマリのみ含めるなど）

### Phase 2: サマリ統合による完全な検索（中期）

LLMでサマリを生成し、contentフィールドに統合する:

```typescript
// サマリ生成
const documentSummary = await generateDocumentSummary(fullContent);

// contentフィールドにサマリを含める
const content = `
Document: ${documentSummary.title}
${documentSummary.summary}

---

${section.content}
`;

// このcontentが単一のベクトルとして保存される
const section: Omit<Section, 'vector'> = {
  id,
  documentPath,
  heading,
  depth,
  content, // サマリ + 階層的コンテンツ
  tokenCount: this.tokenCounter.count(content),
  // ...
};
```

**サマリの形式**:
```
Document: Node.jsプロジェクトのセットアップガイド
このガイドは、Node.js 18以上を使用したプロジェクトの初期セットアップ、
パッケージのインストール、および基本的な使用方法について説明しています。

---

## インストール手順

### 前提条件
Node.js 18以上が必要です。
...
```

これにより、**単一のベクトル**で以下の検索が可能になる:
- "Node.jsのセットアップ" → 文書サマリにマッチ
- "npmインストール" → セクションコンテンツにマッチ
- "Node.jsプロジェクトのnpmインストール" → サマリ+コンテンツの両方にマッチ

## 実装の優先順位

### 必須（Phase 1）✅ 完了
1. ✅ **depth=0を文書全体に変更**
   - contentBufferだけでなく、すべてのH1セクションを子として持つ
   - buildContentで子のコンテンツを含める
   - **実装完了**: `markdown-splitter.ts:114-123`

2. ✅ **親セクションに子のコンテンツを含める**
   - buildContent()を修正
   - トークン数警告の実装
   - **実装完了**: `markdown-splitter.ts:192-216`

3. ✅ **テストの追加**
   - 階層的コンテンツの検証
   - トークン数の計測
   - **実装完了**: 25テストケース全て更新、成功

### 推奨（Phase 2）
4. ⏳ **サマリフィールドの実装**
   - LLMでサマリ生成
   - ベクトル化時にサマリを組み合わせ

5. ⏳ **階層パス情報の追加**
   - metadata.hierarchyPath: ["親", "子", "孫"]

### 将来的（Phase 3）
6. ⏳ **ハイブリッド検索**
   - コンテンツ検索 + サマリ検索
   - 結果のマージとランキング

## 影響範囲

### 変更が必要なファイル
- `packages/server/src/splitter/markdown-splitter.ts`
- `packages/server/src/splitter/__tests__/markdown-splitter.test.ts`

### 影響を受ける機能
- インデックス作成パイプライン
- トークン数計測
- ベクトル検索の精度

### 互換性
- 既存のインデックスは再構築が必要
- APIの変更は不要（内部実装のみ）

## 参考

- 設計ドキュメント: `docs/markdown-splitter-design.md`
- 関連issue: なし（新規課題）
