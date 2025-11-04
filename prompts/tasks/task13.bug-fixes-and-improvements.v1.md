# Task 13: バグ修正と改善項目

> **🔒 この文章はFIXEDです (2025-11-04)**
> 以降の修正は注釈追記のみ許可されます

**日時**: 2025-10-31
**継続セッション**: Task 12（リリース完了）からの継続
**目的**: リリース後に発見された不具合と改善点の修正

## 背景

v1.0.2リリース後、実際に使用する中で以下の問題が発見された。
各問題は独立しているため、個別に集中して作業する。

---

## 問題1: CLIからサーバ起動失敗時にログが残らない

### 症状

- CLIから `search-docs server start` でサーバ起動を試みる
- 起動に失敗した場合、サーバログが残っていないことがある
- 起動しないで終了した可能性もあるが、何らかのログがないと原因調査が困難

### 現状の動作

**packages/cli/src/commands/server/start.ts**:
```typescript
const isDaemon = !options.foreground;

if (isDaemon) {
  // バックグラウンド起動
  const logPath = options.log || path.join(pidInfo.projectRoot, '.search-docs', 'server.log');
  // ...
  const logFd = await fs.open(logPath, 'a');

  const serverProcess = spawn('node', [serverScript], {
    detached: true,
    stdio: ['ignore', logFd.fd, logFd.fd],
    cwd: pidInfo.projectRoot,
  });
}
```

### 問題点

1. **起動前のエラーがログに残らない**
   - PIDファイルのチェック、ポートチェックなどでエラーが起きた場合
   - プロセスが spawn される前に終了するとログファイルが作られない

2. **spawn直後のエラー**
   - モジュールロードエラーなど、プロセス起動直後のエラーが残らない可能性

### 改善方針

1. **起動プロセス全体のログ記録**
   - CLIコマンド実行開始時点からログファイルに記録
   - エラーが起きた場合は必ずログファイルに残す

2. **起動失敗時の明示的なログ出力**
   - spawn失敗、プロセス異常終了を検知してログに記録
   - ユーザーにログファイルの場所を明示

### 実装案

```typescript
// ログファイルを早期に開く
const logPath = options.log || path.join(projectRoot, '.search-docs', 'server.log');
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

const log = (message: string) => {
  const timestamp = new Date().toISOString();
  logStream.write(`[${timestamp}] ${message}\n`);
};

try {
  log('Server start requested');

  // PIDファイルチェック
  log('Checking for existing server...');
  // ...

  // ポートチェック
  log(`Checking port ${port}...`);
  // ...

  // サーバ起動
  log('Spawning server process...');
  const serverProcess = spawn(...);

  serverProcess.on('error', (error) => {
    log(`Server process error: ${error.message}`);
  });

  serverProcess.on('exit', (code, signal) => {
    if (code !== 0) {
      log(`Server process exited with code ${code}, signal ${signal}`);
    }
  });

  log('Server started successfully');
} catch (error) {
  log(`Failed to start server: ${error.message}`);
  console.error(`Error: ${error.message}`);
  console.error(`Check log file: ${logPath}`);
  throw error;
} finally {
  logStream.end();
}
```

### 検証方法

1. 正常起動時: ログファイルに起動プロセスが記録される
2. PIDファイル競合時: エラー内容がログに記録される
3. ポート競合時: エラー内容がログに記録される
4. モジュールロードエラー時: エラー内容がログに記録される

---

## 問題2: MCP Serverの--project-dir必須を緩和

### 症状

- MCP Serverで `--project-dir` オプションが必須になっている
- しかし、configファイルがあれば `project.root` からプロジェクトディレクトリを取得できるはず
- 冗長な指定を強制している

### 現状の動作

**packages/mcp-server/src/server.ts**:
```typescript
function parseArgs() {
  const args = process.argv.slice(2);
  const projectDirIndex = args.indexOf('--project-dir');

  if (projectDirIndex === -1) {
    console.error('Error: --project-dir is required');
    process.exit(1);
  }

  const projectDir = args[projectDirIndex + 1];
  return { projectDir };
}
```

### 改善方針

1. **--project-dir をオプショナルに**
   - 指定されていない場合は、カレントディレクトリから設定ファイルを探索
   - 設定ファイルの `project.root` を使用
   - 設定ファイルがない場合のみエラー

2. **CLI の設定ファイル探索ロジックを再利用**
   - `packages/cli/src/utils/config-resolver.ts` のロジックを共通化
   - または、MCP Serverでも同様の探索を実装

### 実装案

```typescript
// packages/mcp-server/src/server.ts
async function resolveProjectDir(explicitDir?: string): Promise<string> {
  // 1. 明示的に指定されている場合
  if (explicitDir) {
    return path.resolve(explicitDir);
  }

  // 2. カレントディレクトリから設定ファイルを探索
  const configPath = await findConfigFile(process.cwd(), false); // 親を遡らない

  if (!configPath) {
    throw new Error(
      'Configuration file not found. ' +
      'Please specify --project-dir or create .search-docs.json in the current directory.'
    );
  }

  // 3. 設定ファイルから project.root を取得
  const configContent = await fs.readFile(configPath, 'utf-8');
  const config = JSON.parse(configContent);

  if (config.project?.root) {
    const configDir = path.dirname(configPath);
    return path.resolve(configDir, config.project.root);
  }

  // 4. 設定ファイルの親ディレクトリをプロジェクトルートとする
  return path.dirname(configPath);
}

async function main() {
  const args = parseArgs(); // --project-dir はオプショナル
  const projectDir = await resolveProjectDir(args.projectDir);

  // ...
}
```

### 検証方法

1. `--project-dir` 指定あり: 従来通り動作
2. `--project-dir` なし、`.search-docs.json` あり: 設定ファイルから推論
3. `--project-dir` なし、設定ファイルなし: エラーメッセージ表示

---

## 問題3: CLI config initで既存ファイルがある時の挙動改善

### 症状

- `search-docs config init` を実行
- 既存の設定ファイルがある場合、エラーとして終了
- しかし、ファイルが存在することは「エラー」ではなく「状況」である
- 情報メッセージを表示すべき

### 現状の動作

**packages/cli/src/commands/config/init.ts**:
```typescript
const configPath = path.join(projectRoot, '.search-docs.json');

if (await fileExists(configPath)) {
  console.error(`Error: Configuration file already exists: ${configPath}`);
  process.exit(1);
}
```

### 問題点

1. **exit(1) はエラーを意味する**
   - CI/CDで失敗として扱われる
   - ユーザーに「何か悪いことをした」という印象を与える

2. **既存ファイルの存在は正常な状態**
   - 設定ファイルが既にあることは問題ではない
   - 「既に設定済みです」という情報を伝えるべき

### 改善方針

1. **exit(0) で正常終了**
   - 既存ファイルがあることを情報として表示
   - エラーではなく、正常な状態として扱う

2. **より親切なメッセージ**
   - 既存ファイルの場所を表示
   - 上書きしたい場合の方法を案内（将来的に `--force` オプション）

### 実装案

```typescript
const configPath = path.join(projectRoot, '.search-docs.json');

if (await fileExists(configPath)) {
  console.log(`Configuration file already exists: ${configPath}`);
  console.log('No action needed. Your project is already configured.');
  // 将来的には：
  // console.log('Use --force to overwrite the existing file.');
  process.exit(0); // 正常終了
}

// 新規作成
await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
console.log(`Configuration file created: ${configPath}`);
```

### メッセージ改善例

**変更前**:
```
Error: Configuration file already exists: /path/to/.search-docs.json
```

**変更後**:
```
Configuration file already exists: /path/to/.search-docs.json
No action needed. Your project is already configured.
```

### 検証方法

1. 設定ファイルなし: 新規作成、exit(0)
2. 設定ファイルあり: 情報メッセージ表示、exit(0)
3. CI/CDで実行: 既存ファイルがあってもビルド成功

---

## 問題4: ドキュメント更新（Task 10, 11, 12の変更反映）

### 症状

Task 10, 11, 12で以下の実装変更が行われたが、ドキュメントが更新されていない：

1. **Task 10**: ポート設定の修正、MCP Serverサーバ自動起動
2. **Task 11**: サーバ起動デフォルト変更（`--daemon` → `--foreground`）
3. **Task 11**: グローバル --config オプション
4. **Task 11**: 設定ファイル自動探索

### 主な問題箇所

#### packages/mcp-server/README.md

1. **`--daemon` オプションの記載（line 51）**
   - 現在: `node packages/cli/dist/index.js server start --daemon`
   - 修正: デフォルトでバックグラウンド起動に変更されたことを反映

2. **サーバ自動起動機能の記載漏れ**
   - Task 10で実装されたMCP Serverの自動起動機能が記載されていない

3. **`--project-dir` 必須の記載（line 70-71）**
   - 問題2の実装後、オプショナルに変更されることを反映

#### その他のドキュメント

- README.md（ルート）: 使用例の更新
- docs/quick-start.md: 初期セットアップ手順
- docs/cli-reference.md: コマンドオプション
- docs/mcp-integration.md: MCP統合ガイド
- docs/user-guide.md: 設定ファイル管理

### 改善方針

1. **MCP Server README更新**（優先度：高）
   - `--daemon` 削除の反映
   - サーバ自動起動機能の追加
   - `--project-dir` オプショナル化（問題2実装後）

2. **その他ドキュメント更新**（優先度：中）
   - README.md、quick-start.md、cli-reference.md

3. **整合性確認**
   - すべてのドキュメントとコード例の整合性確認

### 実装案

**packages/mcp-server/README.md の修正例**:

```markdown
## サーバ自動起動機能

v1.0.1以降、MCP Serverは自動的にsearch-docsサーバを起動します。

**動作**:
1. MCP Server起動時にサーバへの接続を試みる
2. サーバが起動していない場合、自動的にサーバを起動
3. サーバが起動したら接続を確立

これにより、手動でサーバを起動する必要がなくなりました。

## セットアップ

### Claude Code統合

```json
{
  "mcpServers": {
    "search-docs": {
      "command": "node",
      "args": [
        "/absolute/path/to/search-docs/packages/mcp-server/dist/server.js"
      ]
    }
  }
}
```

**注意**:
- `--project-dir` は省略可能です。省略した場合、カレントディレクトリの `.search-docs.json` から自動的にプロジェクトディレクトリを推論します。
- 明示的に指定する場合は `--project-dir ${workspaceFolder}` を追加してください。
```

### 検証方法

1. 各ドキュメントの記載が最新の実装と一致している
2. コード例が実際に動作する
3. 誤解を招く古い情報がない

---

## 問題5: 検索のdepth（深さ）の意味を分かりやすく

### 症状

検索時に指定する `depth` パラメータが何を意味しているのか、ユーザーに伝わっていない。

**現在の出力例**:
```
docs/architecture.md > アーキテクチャ概要
depth: 1
score: 0.85
---
本文内容...
```

**問題点**:
- `depth: 1` が「H1見出しのセクション」を意味することが自明でない
- ドキュメントを章立てで分割していることが理解されていない
- depthの数値とMarkdown見出しレベルの対応が不明

### 改善方針

#### 1. CLI出力でdepthの意味を明示

**改善後の出力例**:
```
docs/architecture.md > アーキテクチャ概要
depth: 1 (H1セクション)
score: 0.85
---
本文内容...
```

または、より詳細に:
```
docs/architecture.md > アーキテクチャ概要
level: H1 (depth: 1)
score: 0.85
---
本文内容...
```

#### 2. ヘルプメッセージの改善

**packages/cli/src/index.ts**:
```typescript
searchCmd
  .command('search <query>')
  .description('文書を検索')
  .option(
    '-d, --depth <depth>',
    '検索深度: 0=文書全体, 1=H1セクション, 2=H2セクション, 3=H3セクション (デフォルト: すべて)'
  )
  .option('-l, --limit <limit>', '結果数制限 (デフォルト: 10)', '10')
  .option('--format <format>', '出力形式: text, json (デフォルト: text)', 'text');
```

#### 3. MCP Serverのツール説明改善

**packages/mcp-server/src/server.ts**:
```typescript
{
  name: "search",
  description: "文書を検索します。文書はMarkdown見出しで自動的に分割されています。",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "検索クエリ"
      },
      depth: {
        oneOf: [
          { type: "number" },
          { type: "array", items: { type: "number" } }
        ],
        description: "検索深度（0: 文書全体, 1: H1セクション, 2: H2セクション, 3: H3セクション）。配列で複数指定可能。"
      },
      // ...
    }
  }
}
```

#### 4. 検索結果のラベル統一

現在の `depth` という技術的な用語ではなく、ユーザーにわかりやすい表現に変更：

**案A**: `level` に変更
```
level: H1
```

**案B**: `depth` を残しつつ説明を追加
```
depth: 1 (H1)
```

**案C**: 完全に置き換え
```
section type: H1
```

**推奨**: 案B（互換性を保ちつつ分かりやすく）

#### 5. ドキュメントでの説明強化

**README.md**に追加:
```markdown
## ドキュメントの分割とdepth

search-docsは、Markdown文書を見出しレベルで自動的に分割します：

- **depth 0**: 文書全体
- **depth 1**: H1セクション（`# 見出し`）
- **depth 2**: H2セクション（`## 見出し`）
- **depth 3**: H3セクション（`### 見出し`）

検索時に `--depth` を指定することで、特定のレベルのセクションのみを検索できます。

例:
```bash
# H1セクションのみ検索（章レベル）
search-docs search "検索クエリ" --depth 1

# H2とH3セクションを検索（節・項レベル）
search-docs search "検索クエリ" --depth 2,3
```
```

### 実装案

**packages/cli/src/commands/search.ts**:
```typescript
function formatSearchResult(result: Section): string {
  const pathAndHeading = result.heading
    ? `${result.documentPath} > ${result.heading}`
    : result.documentPath;

  let output = `\n${pathAndHeading}\n`;

  // depthの意味を明示
  const depthLabels = [
    'document (全体)',
    'H1 (章)',
    'H2 (節)',
    'H3 (項)'
  ];
  const depthLabel = depthLabels[result.depth] || `depth-${result.depth}`;
  output += `level: ${depthLabel}\n`;

  // または
  // output += `depth: ${result.depth} (${depthLabel})\n`;

  output += `score: ${result._score?.toFixed(2) || 'N/A'}\n`;
  // ...
}
```

### 検証方法

1. CLIヘルプメッセージでdepthの意味が明確
2. 検索結果でdepthが何を意味するか分かる
3. MCP Serverのツール説明が分かりやすい
4. ドキュメントで分割の仕組みが説明されている

---

## 作業の進め方

各問題は独立しているため、以下の順序で個別に作業する：

### 優先順位

1. **問題3（config init）**: 最も簡単、影響範囲が小さい
2. **問題5（depth説明）**: 簡単、ユーザー体験向上
3. **問題4（ドキュメント更新）**: 重要度が高い、ユーザー向け情報
4. **問題1（サーバログ）**: 重要度が高い、デバッグに必須
5. **問題2（MCP project-dir）**: やや複雑、共通化が必要

### 各問題の作業フロー

1. 現状確認（コード読解）
2. 修正実装
3. 動作確認（手動テスト）
4. コミット
5. 次の問題へ

---

**作成日時**: 2025-10-31
**ステータス**: 計画完了、実装待ち
