# Task 11: CLI改善 - デフォルト動作とグローバルオプション

## 概要

- **日時**: 2025-01-30
- **継続セッション**: Task 10（v1.0.1リリース）からの継続
- **目的**: CLIの使い勝手向上

## 背景

v1.0.1リリース後、CLIの動作について改善点が見つかった：

1. **サーバ起動のデフォルト動作**
   - 現状: フォアグラウンドがデフォルト、`--daemon` でバックグラウンド
   - 問題: 実運用ではバックグラウンドが基本
   - 改善: バックグラウンドをデフォルトに

2. **--config オプションの位置**
   - 現状: 各サブコマンドに個別に定義（search, index rebuild, index status）
   - 問題: `search-docs --config xxx search "query"` が通らない
   - 改善: ルートレベルでグローバルオプションとして定義

3. **設定ファイルの探索**
   - 現状: プロジェクトルート（明示的に指定されたパス）のみ
   - 問題: サブディレクトリから実行すると設定が見つからない
   - 改善:
     - **CLI（search, index等）**: 親ディレクトリを遡って `.search-docs.json` を探す
     - **Server/MCP Server**: カレントディレクトリのみ（遡らない） - プロジェクトルートで起動される想定

## 起動処理とConfig周りの調査結果

**調査レポート**: @prompts/tasks/research.config-startup.v1.md

### 発見した問題点

1. **Config読み込みの重複実装**
   - CLI: 直接 `readFileSync` + `JSON.parse`（バリデーションなし）
   - Server: `ConfigLoader.load()`（バリデーション・デフォルト値マージあり）
   - MCP Server: 独自の `loadConfig()`（簡易的なデフォルト値マージ）

2. **プロジェクトルート解決の不統一**
   - CLI: `findProjectRoot()` + `normalizeProjectRoot()`（シンボリックリンク解決）
   - Server: `process.cwd()` + `path.resolve()`
   - MCP Server: `path.resolve()` のみ

3. **設定ファイル名が統一されていない**
   - CLI: `.search-docs.json` または `search-docs.json`
   - Server: `search-docs.json`（環境変数で変更可）
   - MCP Server: `.search-docs.json`

4. **ConfigLoaderが活用されていない**
   - `@search-docs/server`に実装済みだが、CLIとMCP Serverは使用していない

### リファクタリング提案

#### 高優先度（Task 11と同時実装）

1. **共通Config解決ユーティリティの作成**
   - 場所: `packages/types/src/config/resolver.ts` (新規)
   - 機能: 設定ファイル探索、プロジェクトルート決定、ConfigLoader使用
   - Task 11で必要な機能と重複するため、同時実装が効率的

2. **設定ファイル名の統一**
   - 推奨: `.search-docs.json` に統一
   - 後方互換性: `search-docs.json` も引き続きサポート
   - 探索優先順位: `.search-docs.json` > `search-docs.json`

#### 中優先度（Task 11後の整理）

3. **ConfigLoaderの共通パッケージ移動**
   - 移動先: `@search-docs/types`
   - 影響: すべてのパッケージで利用可能に

4. **Server/MCP Serverの共通ユーティリティ移行**
   - 既存コードを共通ユーティリティに置き換え

### Task 11実装への影響

**Phase 2（グローバル --config オプション）を拡張**:
- `config-resolver.ts` の実装を共通ユーティリティとして作成
- 単なるファイル探索ではなく、ConfigLoader統合も含める
- CLIだけでなく、将来的にServer/MCP Serverでも使用可能な設計

**実装の調整**:
```typescript
// packages/types/src/config/resolver.ts (新規)
export async function resolveConfig(options: ResolveConfigOptions): Promise<{
  config: SearchDocsConfig;
  configPath: string;
  projectRoot: string;
}>;
```

これにより、Task 11の実装と同時にコード整理も進められる。

## 実装方針

### 1. サーバ起動のデフォルト動作変更

#### 変更前
```bash
search-docs server start           # フォアグラウンド
search-docs server start --daemon  # バックグラウンド
```

#### 変更後
```bash
search-docs server start              # バックグラウンド（デフォルト）
search-docs server start --foreground # フォアグラウンド（開発時）
```

#### 実装詳細

**packages/cli/src/commands/server/start.ts**:
```typescript
export interface ServerStartOptions {
  config?: string;
  port?: string;
  foreground?: boolean;  // daemon から foreground に変更
  log?: string;
}

// デフォルト動作を反転
const isDaemon = !options.foreground;  // foreground が false ならデーモン
```

**packages/cli/src/index.ts**:
```typescript
serverCmd
  .command('start')
  .description('サーバを起動')
  .option('--config <path>', '設定ファイルのパス')
  .option('--port <port>', 'ポート番号')
  .option('-f, --foreground', 'フォアグラウンドで起動（開発時）')  // 変更
  .option('--log <path>', 'ログファイルのパス')
  .action((options: ServerStartOptions) => {
    void executeServerStart(options);
  });
```

#### MCP Serverからの起動

**packages/mcp-server/src/server-manager.ts**:
```typescript
async startServer(projectDir: string, port: number, configPath?: string): Promise<void> {
  const cliPath = await this.resolveCliPath();

  const args = [
    'server',
    'start',
    '--foreground',  // 明示的にフォアグラウンド指定
    '--port',
    port.toString()
  ];

  if (configPath) {
    args.push('--config', configPath);
  }

  const serverProcess = spawn('node', [cliPath, ...args], {
    cwd: projectDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,  // プロセス連動
  });

  // ...
}
```

**理由**:
- MCPプロセス終了時にサーバも自動終了させたい
- ログをキャプチャしてエラーを確認したい
- デーモン化すると別プロセスになって管理が複雑

### 2. --config をグローバルオプションに

code-bugsのパターンを参考に実装。

#### 変更前
```bash
# これが通らない
search-docs --config ./custom.json search "query"

# これしかできない
search-docs search --config ./custom.json "query"
```

#### 変更後
```bash
# 両方通るように
search-docs --config ./custom.json search "query"
search-docs search --config ./custom.json "query"
```

#### 実装詳細

**packages/cli/src/index.ts**:
```typescript
import { Command, Option } from 'commander';

const program = new Command();

program
  .name('search-docs')
  .description('search-docs コマンドラインツール')
  .version(packageJson.version)
  .addOption(
    new Option('-c, --config <path>', '設定ファイルのパス')
      .default(undefined)  // デフォルトは自動探索
      .env('SEARCH_DOCS_CONFIG')  // 環境変数もサポート
  )
  .hook('preSubcommand', async (thisCommand, _actionCommand) => {
    const opts = thisCommand.opts();
    // グローバルオプションをサブコマンドに渡す処理
    // 実装検討中...
  });

// 各サブコマンドから --config オプションを削除
```

**課題**:
- Commanderでグローバルオプションをサブコマンドに伝播させる方法
- 各コマンド実装で `options.config` にアクセスできるようにする

**参考**: code-bugsは `preSubcommand` フックで `setup(opts)` を呼んでグローバル設定を準備

### 3. 設定ファイルの自動探索

#### 探索順序

**CLI（search, index rebuild, index status）の場合**:
```
1. --config オプションで明示的に指定されたパス
2. 環境変数 SEARCH_DOCS_CONFIG
3. カレントディレクトリから親を遡って .search-docs.json を探す
   - process.cwd()/.search-docs.json
   - process.cwd()/../.search-docs.json
   - process.cwd()/../../.search-docs.json
   - ... (ルートディレクトリまたは見つかるまで)
4. 見つからなければデフォルト設定で動作
```

**Server/MCP Serverの場合**:
```
1. --config オプションで明示的に指定されたパス
2. 環境変数 SEARCH_DOCS_CONFIG
3. カレントディレクトリの .search-docs.json のみ
   - process.cwd()/.search-docs.json
   - （親は遡らない - プロジェクトルートで起動される想定）
4. 見つからなければデフォルト設定で動作
```

#### 実装詳細

**packages/cli/src/utils/config-resolver.ts** (新規作成):
```typescript
import * as path from 'path';
import { promises as fs } from 'fs';

/**
 * 設定ファイルを探索
 * @param startDir 探索開始ディレクトリ
 * @param traverseUp 親ディレクトリを遡るかどうか
 */
export async function findConfigFile(
  startDir: string = process.cwd(),
  traverseUp: boolean = true
): Promise<string | null> {
  let currentDir = path.resolve(startDir);
  const root = path.parse(currentDir).root;

  while (true) {
    const configPath = path.join(currentDir, '.search-docs.json');

    try {
      await fs.access(configPath);
      return configPath;
    } catch {
      // ファイルが存在しない
    }

    // 親を遡らない場合はここで終了
    if (!traverseUp) {
      return null;
    }

    // ルートディレクトリに到達したら終了
    if (currentDir === root) {
      return null;
    }

    // 親ディレクトリへ
    currentDir = path.dirname(currentDir);
  }
}

/**
 * 設定ファイルパスを解決
 * @param explicitPath 明示的に指定されたパス
 * @param traverseUp 親ディレクトリを遡るかどうか
 */
export async function resolveConfigPath(
  explicitPath?: string,
  traverseUp: boolean = true
): Promise<string | null> {
  // 1. 明示的に指定されている
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  // 2. 環境変数
  const envPath = process.env.SEARCH_DOCS_CONFIG;
  if (envPath) {
    return path.resolve(envPath);
  }

  // 3. 自動探索
  return await findConfigFile(process.cwd(), traverseUp);
}
```

**既存コード修正**:

`packages/cli/src/utils/project.ts` の `findProjectRoot()` を修正して、
`resolveConfigPath()` を使うように変更。

## 参考: code-bugs の実装パターン

### グローバルオプション定義

```typescript
program
  .name('code-bugs')
  .option('-b, --base-dir <baseDir>', 'base directory', process.cwd())
  .addOption(
    new Option('-c, --config <config>', 'config.json')
      .default(defaultConfigPath)
      .env('CODE_BUGS_CONFIG')
  )
```

### preSubcommand フック

```typescript
  .hook('preSubcommand', async (thisCommand, _actionCommand) => {
    const opts = thisCommand.opts<CommandOptions>();
    config = await setup(opts);  // グローバル設定を準備
  })
```

### サブコマンドでの利用

```typescript
cmd.action(async function() {
  // config はグローバル変数として利用可能
  await action(config, this.args, this.opts(), this);
});
```

## 検討事項

### グローバルオプションの伝播方法

**案A: グローバル変数を使う（code-bugsパターン）**
```typescript
let globalConfig: Config | undefined;

program.hook('preSubcommand', async (thisCommand) => {
  const opts = thisCommand.opts();
  globalConfig = await loadConfig(opts);
});

// 各コマンドで globalConfig を参照
```

**案B: コマンドコンテキストに注入**
```typescript
program.hook('preSubcommand', async (thisCommand, actionCommand) => {
  const opts = thisCommand.opts();
  const config = await loadConfig(opts);

  // actionCommandに設定を注入
  actionCommand._config = config;
});
```

**案C: 各コマンドで個別に解決**
```typescript
// 現在の実装に近い
// 各コマンドで resolveConfigPath() を呼ぶ
```

**推奨**: 案A（code-bugsパターン）
- シンプルで理解しやすい
- 実績あり

## タスクリスト

### Phase 1: サーバ起動デフォルト変更

- [ ] ServerStartOptions の `daemon` を `foreground` に変更
- [ ] デフォルト動作を反転（バックグラウンドがデフォルト）
- [ ] CLIオプションを `--foreground` に変更
- [ ] MCP Serverの起動に `--foreground` を追加
- [ ] ドキュメント更新

### Phase 2: グローバル --config オプション

- [ ] config-resolver.ts 作成（設定ファイル自動探索）
- [ ] program レベルで --config オプション定義
- [ ] 環境変数 SEARCH_DOCS_CONFIG サポート
- [ ] preSubcommand フック実装
- [ ] 各サブコマンドから個別の --config オプション削除
- [ ] グローバル設定をサブコマンドに伝播

### Phase 3: テストと検証

- [ ] 設定ファイル自動探索のテスト
- [ ] グローバルオプションの動作確認
- [ ] MCP Serverからの起動確認
- [ ] ドキュメント更新

## 次の改善候補（将来）

今後、動作が気になったところを追加していく：

### 1. 検索結果の表示マーク改善

**現状**:
- 検索結果に `[最新]` マークが付く

**問題点**:
- 最新の場合にマークが付くのは冗長
- ほとんどが最新の場合、ノイズになる

**改善案**:
- **最新の場合**: マークを付けない（デフォルト状態）
- **古い場合**: 別のマークを付ける（例: `[古]`, `[Dirty]`, `⚠️`, `🔄` など）

**理由**:
- 正常な状態（最新）は明示不要
- 注意が必要な状態（古い）のみ強調する方が情報設計として適切

### 2. サマリワーカーの追加

**目的**:
- セクションの要約を自動生成
- 文書全体の要約を自動生成

**背景**:
- データモデルには `summary` と `documentSummary` フィールドが定義済み（オプショナル）
- 現在は未実装

**実装イメージ**:
- Dirtyワーカーと同様のバックグラウンドワーカー
- LLMを使用してセクション・文書の要約を生成
- 検索コンテキストの充実化

**ステータス**: ペンディング（将来実装）

---

**作成日時**: 2025-01-30 23:20
**ステータス**: 計画中
