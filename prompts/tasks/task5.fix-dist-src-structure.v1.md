# Task 5: dist/src構造の解消

## 問題

cliパッケージだけが `dist/src/` という冗長な構造になっている。

### 現状分析

**ディレクトリ構造**:
```
packages/cli/
├── bin/
│   └── search-docs.ts  # 単に ../src/index.js をimport
├── src/
│   ├── index.ts
│   └── commands/...
└── dist/
    ├── bin/
    │   └── search-docs.js
    └── src/           # ← 冗長
        ├── index.js
        └── commands/...
```

**原因**:
```json
// tsconfig.json
{
  "rootDir": ".",
  "include": ["src/**/*", "bin/**/*"]
}
```

**依存箇所**:
- `src/index.ts`: `__dirname` から `../../package.json`
- `src/commands/server/start.ts`: `__dirname` から `../../../../package.json`

**bin/の存在意義**: なし
- `bin/search-docs.ts` は単に `../src/index.js` をimportするだけ
- serverパッケージのbin/は実際のロジックを含むので必要だが、cliは不要

## 作業計画

### 1. bin/ディレクトリの削除
- [x] bin/search-docs.ts の削除

### 2. src/index.ts の修正
- [x] shebang `#!/usr/bin/env node` の追加
- [x] __dirname 相対パスの修正（`../../` → `../`）

### 3. 設定ファイルの修正
- [x] package.json の bin を `dist/index.js` に変更
- [x] package.json の dev スクリプトを `tsx src/index.ts` に変更
- [x] tsconfig.json を修正:
  - rootDir: "src"
  - include: ["src/**/*"]

### 4. start.ts の修正
- [x] __dirname 相対パスの修正（`../../../../` → `../../`）

### 5. ビルドと動作確認
- [x] distクリーン
- [x] ビルド実行
- [x] dist/の構造確認
- [x] E2Eテスト実行

### 6. コミット
- [x] 変更をコミット

## 期待される結果

```
packages/cli/dist/
├── index.js         # CLI エントリポイント
├── commands/
│   └── server/
│       ├── start.js
│       ├── stop.js
│       ├── restart.js
│       └── status.js
└── utils/
    ├── pid.js
    ├── process.js
    └── project.js
```

## 将来の課題

なし
