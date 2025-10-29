# Task: dist/src構造の課題

## 概要

現在のTypeScriptビルド設定では、ビルド成果物が`dist/src/`配下に出力されており、これは標準的な構造ではない。

## 現在の構造

```
packages/cli/
├── src/
│   ├── commands/
│   ├── utils/
│   └── index.ts
└── dist/
    └── src/           # ← 問題: srcがネストしている
        ├── commands/
        ├── utils/
        └── index.js
```

## 期待される構造

```
packages/cli/
├── src/
│   ├── commands/
│   ├── utils/
│   └── index.ts
└── dist/             # ← srcディレクトリなし
    ├── commands/
    ├── utils/
    └── index.js
```

## 影響

### 1. パス解決の複雑さ

`__dirname`からの相対パス計算が複雑になっている:

```typescript
// 現在: dist/src/commands/server/start.js から package.json へ
const fallbackPath = path.join(__dirname, '../../../../package.json');

// 期待: dist/commands/server/start.js から package.json へ
const fallbackPath = path.join(__dirname, '../../../package.json');
```

### 2. import.meta.resolve()の動作

一部の環境で`import.meta.resolve('@search-docs/cli')`が失敗するため、フォールバック機構を実装する必要があった。

## 原因

`tsconfig.json`の設定問題:

```json
{
  "compilerOptions": {
    "rootDir": ".",      // ← これが原因
    "outDir": "./dist"
  }
}
```

`rootDir`が`.`(プロジェクトルート)に設定されているため、`src/`ディレクトリの構造がそのまま保持される。

## 解決策

### オプション1: rootDirを修正

```json
{
  "compilerOptions": {
    "rootDir": "./src",  // ← src を rootDir に
    "outDir": "./dist"
  },
  "include": ["src/**/*"]
}
```

**メリット:**
- 標準的な構造になる
- パス計算が簡単になる

**デメリット:**
- 既存のパス参照を全て修正する必要がある
- ビルドスクリプトの調整が必要かも

### オプション2: outDirを変更

```json
{
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "./dist/src"  // ← 明示的に dist/src を指定
  }
}
```

**メリット:**
- 現状を明示的にする
- 既存コードへの影響なし

**デメリット:**
- 非標準的な構造のまま

## 推奨アクション

**オプション1を採用すべき:**

1. `tsconfig.json`で`rootDir: "./src"`に変更
2. ビルドして動作確認
3. すべてのE2Eテストを実行
4. パス関連のフォールバック機構を見直し・簡略化

## 関連ファイル

- `packages/cli/tsconfig.json` - TypeScript設定
- `packages/cli/src/commands/server/start.ts:140-143` - package.jsonパス解決のフォールバック
- `packages/cli/src/index.ts:28-33` - package.jsonパス解決

## 参考

- [TypeScript Compiler Options - rootDir](https://www.typescriptlang.org/tsconfig#rootDir)
- [TypeScript Compiler Options - outDir](https://www.typescriptlang.org/tsconfig#outDir)

## ステータス

- 発見日: 2025-10-29
- 優先度: 中（機能的には問題ないが、保守性に影響）
- 実装予定: 次の大きな変更時に対応
