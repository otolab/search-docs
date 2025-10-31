# 起動処理とConfig扱いの調査

**調査日時**: 2025-01-31
**目的**: CLI, Server, MCP Serverの起動処理とconfig読み込み処理の現状分析とリファクタリング提案
**関連タスク**: Task 11 (CLI改善)

## 調査対象

1. CLI起動処理とconfig読み込み
2. Server起動処理とconfig読み込み
3. MCP Server起動処理とconfig読み込み
4. 共通化可能な処理の特定

## 発見事項

### ドキュメントからの情報

検索結果より：
- `docs/server-process-management.md`: プロジェクトルート決定方法の詳細
- `prompts/tasks/task10.port-config-and-auto-start.v1.md`: ポート設定読み込み実装
- `prompts/tasks/task11.cli-improvements.v1.md`: 設定ファイル自動探索の計画

### コード調査

#### 1. CLI起動処理 (packages/cli/src/commands/server/start.ts)

**Config読み込み**: lines 56-69
```typescript
// 設定ファイルを直接読み込み
const configContent = readFileSync(configPath, 'utf-8');
config = JSON.parse(configContent) as typeof config;
```

**特徴**:
- `ConfigLoader`を使用せず、直接`readFileSync` + `JSON.parse`
- 設定ファイルが見つからない場合はエラー
- デフォルト値のマージなし

**プロジェクトルート解決**: lines 44-51
- `findProjectRoot()` 使用 (utils/project.ts)
- `resolveConfigPath()` 使用 (utils/project.ts)
- カレントディレクトリから遡って探索

#### 2. Server起動処理 (packages/server/src/bin/server.ts)

**Config読み込み**: lines 15-17
```typescript
const configPath = process.env.SEARCH_DOCS_CONFIG || path.join(process.cwd(), 'search-docs.json');
const config = await ConfigLoader.load(configPath);
```

**特徴**:
- `ConfigLoader.load()` を使用
- 設定ファイルが見つからない場合はデフォルト設定を返す
- デフォルト値との完全なマージ
- 環境変数 `SEARCH_DOCS_CONFIG` サポート

**プロジェクトルート解決**: lines 20-22
- `config.project.root` から解決
- `process.cwd()` を基準とした相対パス解決
- `normalizeProjectRoot()` などは使用せず

#### 3. MCP Server起動処理 (packages/mcp-server/src/server.ts)

**Config読み込み**: lines 34-49
```typescript
async function loadConfig(projectDir: string): Promise<SearchDocsConfig> {
  const configPath = path.join(projectDir, '.search-docs.json');
  const content = await fs.readFile(configPath, 'utf-8');
  const config = JSON.parse(content) as SearchDocsConfig;
  return {
    server: {
      host: config.server?.host || DEFAULT_CONFIG.server.host,
      port: config.server?.port || DEFAULT_CONFIG.server.port,
    },
  };
}
```

**特徴**:
- 独自実装（ConfigLoaderを使用せず）
- 固定パス `.search-docs.json`
- 簡易的なデフォルト値マージ（server設定のみ）
- 設定ファイルが見つからない場合はデフォルト設定

**プロジェクトルート**: lines 75, 84
- CLIオプション `--project-dir` で明示的に指定
- `path.resolve()` で絶対パス化

#### 4. 共通ユーティリティ

**packages/cli/src/utils/project.ts**:
- `findProjectRoot()`: プロジェクトルート探索（設定ファイルから自動検出）
- `resolveConfigPath()`: 設定ファイルパス解決（複数候補を探索）
- `normalizeProjectRoot()`: パス正規化（シンボリックリンク解決）

**packages/cli/src/utils/server-url.ts**:
- `resolveServerUrl()`: サーバURL解決
- 優先順位: --server > 設定ファイル > デフォルト
- 内部で `findProjectRoot()` と `resolveConfigPath()` を使用

**packages/server/src/config/loader.ts**:
- `ConfigLoader.load()`: 設定ファイル読み込み
- バリデーション + デフォルト値マージ
- 設定ファイルが無ければデフォルト設定を返す

## 問題点の特定

### 1. Config読み込みの重複実装

**問題**:
- CLI: 直接 `readFileSync` + `JSON.parse`
- Server: `ConfigLoader.load()`
- MCP Server: 独自の `loadConfig()`

**影響**:
- 同じ処理が3箇所で異なる方法で実装
- デフォルト値の扱いが不統一（CLIはエラー、他はデフォルト設定）
- バリデーションが一部でしか実行されない

### 2. プロジェクトルート解決の重複

**問題**:
- CLI: `findProjectRoot()` + `normalizeProjectRoot()`
- Server: `process.cwd()` + `path.resolve()`
- MCP Server: `path.resolve()` のみ

**影響**:
- シンボリックリンクの扱いが不統一
- プロジェクトルートの決定ロジックが異なる

### 3. 設定ファイルパスの探索

**問題**:
- CLI: `resolveConfigPath()` で複数候補を探索 (.search-docs.json, search-docs.json)
- Server: 環境変数 または 固定パス (search-docs.json)
- MCP Server: 固定パス (.search-docs.json)

**影響**:
- 設定ファイル名が統一されていない
- ファイルが見つからない場合の動作が不統一

### 4. ConfigLoaderが活用されていない

**問題**:
- `@search-docs/server` パッケージに `ConfigLoader` が実装済み
- しかし、CLIとMCP Serverは独自実装を使用

**影響**:
- バリデーション機能が一部でしか利用されない
- デフォルト値マージのロジックが重複

## リファクタリング提案

### 提案1: 共通Config解決ユーティリティの作成

**新規パッケージ**: `@search-docs/config` または既存の `@search-docs/types` に追加

**実装内容**:
```typescript
// packages/types/src/config/resolver.ts (新規)

/**
 * Config解決オプション
 */
export interface ResolveConfigOptions {
  /** 明示的に指定された設定ファイルパス */
  configPath?: string;
  /** 親ディレクトリを遡って探索するか（CLI用） */
  traverseUp?: boolean;
  /** カレントワーキングディレクトリ */
  cwd?: string;
}

/**
 * 統一されたConfig解決ユーティリティ
 * - 設定ファイルの探索
 * - プロジェクトルートの決定
 * - ConfigLoaderを使用した読み込み
 */
export async function resolveConfig(
  options: ResolveConfigOptions = {}
): Promise<{
  config: SearchDocsConfig;
  configPath: string;
  projectRoot: string;
}> {
  // 1. 設定ファイルパスを解決
  const configPath = await findConfigFile(options);

  // 2. プロジェクトルートを決定
  const projectRoot = await determineProjectRoot(configPath, options);

  // 3. ConfigLoaderで読み込み
  const config = await ConfigLoader.load(configPath);

  return { config, configPath, projectRoot };
}
```

**利点**:
- 全パッケージで統一されたConfig読み込み
- バリデーション・デフォルト値マージが確実に実行される
- プロジェクトルート解決ロジックの一元化

### 提案2: ConfigLoaderを共通パッケージに移動

**現状**: `@search-docs/server` に存在
**提案**: `@search-docs/types` または新規 `@search-docs/config` に移動

**理由**:
- CLI、Server、MCP Serverすべてで利用可能に
- 型定義と設定読み込みをセットで管理

**影響**:
- `@search-docs/server` の依存関係を調整
- すべてのパッケージから `ConfigLoader` をインポート可能に

### 提案3: 設定ファイル名の統一

**現状**:
- CLI: `.search-docs.json` または `search-docs.json`
- Server: `search-docs.json` （環境変数で変更可）
- MCP Server: `.search-docs.json`

**提案**: `.search-docs.json` に統一

**理由**:
- ドット始まりのファイルは設定ファイルの慣習
- `.gitignore` などと同じパターン
- プロジェクトルートに配置されることが明確

**マイグレーション**:
- 既存の `search-docs.json` もサポート（後方互換性）
- 探索優先順位: `.search-docs.json` > `search-docs.json`

### 提案4: Task 11との統合

**Task 11の計画**:
- グローバル `--config` オプション
- 設定ファイル自動探索（traverseUp機能）
- 環境変数 `SEARCH_DOCS_CONFIG` サポート

**統合アプローチ**:
1. **Phase 1**: 共通ユーティリティ作成（提案1）
2. **Phase 2**: Task 11実装時に共通ユーティリティを使用
3. **Phase 3**: ServerとMCP Serverも共通ユーティリティに移行

**実装順序**:
```
1. packages/types/src/config/resolver.ts 作成
   ↓
2. packages/cli で使用開始（Task 11実装）
   ↓
3. ConfigLoader を types パッケージに移動
   ↓
4. packages/server/src/bin/server.ts を共通ユーティリティに移行
   ↓
5. packages/mcp-server/src/server.ts を共通ユーティリティに移行
```

## 優先度付け

### 高優先度（Task 11と同時実装推奨）

1. **共通Config解決ユーティリティの作成**（提案1）
   - Task 11で必要な機能と重複
   - 実装時に一緒に作成すると効率的

2. **設定ファイル名の統一**（提案3）
   - Task 11で探索ロジックを実装する際に合わせて決定
   - 後方互換性を保ちつつ統一

### 中優先度（Task 11後の整理フェーズ）

3. **ConfigLoaderの共通パッケージ移動**（提案2）
   - リファクタリング作業
   - 影響範囲が広いため慎重に実施

4. **Server/MCP Serverの共通ユーティリティ移行**（提案4の後半）
   - 既存コードの書き換え
   - 動作確認が必要

## まとめ

### 発見した主な問題

1. Config読み込みが3箇所で異なる実装
2. プロジェクトルート解決の重複と不統一
3. ConfigLoaderが活用されていない
4. 設定ファイル名が統一されていない

### 推奨アクション

**Task 11実装時に同時実施**:
- 共通Config解決ユーティリティの作成
- 設定ファイル名を `.search-docs.json` に統一（後方互換性維持）
- CLIで共通ユーティリティを使用開始

**Task 11完了後のリファクタリング**:
- ConfigLoaderを共通パッケージに移動
- ServerとMCP Serverを共通ユーティリティに移行
- 重複コードの削除

---

**調査完了日時**: 2025-01-31
**次のステップ**: Task 11に調査結果を報告
