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

## 完了サマリー

### 実施内容

1. **bin/ディレクトリの削除**
   - `bin/search-docs.ts` を削除（単なるreexportで不要）

2. **src/index.tsの修正**
   - shebang `#!/usr/bin/env node` を追加
   - __dirname相対パス: `../../package.json` → `../package.json`

3. **設定ファイルの修正**
   - package.json: bin を `./dist/index.js` に変更
   - package.json: dev スクリプトを `tsx src/index.ts` に変更
   - tsconfig.json: `rootDir: "src"`, `include: ["src/**/*"]`

4. **start.tsの修正**
   - fallback __dirname相対パス: `../../../../package.json` → `../../../package.json`

5. **E2Eテストの修正**
   - テスト内のパス参照: `../dist/bin/search-docs.js` → `../dist/index.js`

### 結果

**変更前**:
```
dist/
├── bin/
│   └── search-docs.js
└── src/              # 冗長
    ├── index.js
    ├── commands/
    └── utils/
```

**変更後**:
```
dist/
├── index.js         # CLIエントリポイント
├── commands/
│   └── server/
└── utils/
```

**テスト結果**: 5/5 E2Eテスト合格 ✅

**コミット**: d20d93f

### 効果

- ✅ dist/src/という冗長な構造を解消
- ✅ モノレポ内で一貫した構造（他パッケージと同様にdist/直下に出力）
- ✅ __dirname相対パスが正しく動作
- ✅ bin/という不要なディレクトリを削除

## 将来の課題

なし
