# Task18 v2: ファイルWatch機能の根本的改善

## 作業概要

v1で基本的なEMFILE対策（usePollingオプション追加）を実施しましたが、根本的な問題が残っています。
**現在の実装はrootDir全体を監視しており、大規模プロジェクトでファイルディスクリプタを大量消費します。**

## 問題の再確認

### 現在の実装の問題点

```typescript
// file-watcher.ts:64
this.watcher = chokidar.watch(this.rootDir, {  // ← プロジェクトルート全体を監視
  ignored: (filePath: string, stats?: Stats) => {
    // フィルタリングで除外
  },
  depth: 99,  // ← 深い階層まで監視
});
```

**問題**:
1. rootDir全体を監視対象に指定
2. ignoredコールバックでフィルタリングしているが、chokidarは最初に全ディレクトリをスキャン
3. 結果：大規模プロジェクト（large-test-projectなど）で数万のファイルディスクリプタを消費
4. `EMFILE: too many open files`エラーが発生

### なぜこの実装になっているか

コメントより:
> chokidar 4.x では Globパターン（例: '**/*.md'）を直接watchに渡すと
> ファイルイベントが発火しない問題があるため、rootDirを監視して
> ignored callbackでフィルタリングする方式を採用

**chokidar 4.xの制約に対するワークアラウンド**だが、大規模プロジェクトでは限界がある。

## 実施する3つの対策

### 1. chokidarの最新バージョン確認・更新

**目的**: chokidar 4.xのGlobパターン問題が修正されている可能性を確認

**作業内容**:
- 現在のバージョン確認: `chokidar@^4.0.3`
- npmで最新バージョンを確認
- changelog確認（特にGlobパターンの修正）
- 可能であれば最新版に更新
- Globパターンが直接使えるようになっていれば、実装をシンプルに変更

**期待される効果**:
- Globパターンが使えれば、includeパターンを直接指定可能
- 監視対象を最小限に絞り込める

### 2. includeパターンに基づく監視対象の絞り込み

**目的**: rootDir全体ではなく、必要なディレクトリ/ファイルのみを監視

**設計方針**:

#### 2.1 includeパターンの解析

設定例:
```json
{
  "files": {
    "include": [
      "docs/**/*.md",
      "README.md",
      "packages/*/README.md"
    ]
  }
}
```

これを以下のように解析:
```typescript
// トップレベルのディレクトリを抽出
["docs", "packages"]

// ルート直下のファイルを抽出
["README.md"]
```

#### 2.2 監視対象の構築

**Option A: chokidar 5.x以降でGlobが使えれば**:
```typescript
chokidar.watch(includePatterns, {
  cwd: this.rootDir,
  ignored: excludePatterns,
  // ...
});
```

**Option B: chokidar 4.xでGlobが使えなければ**:
```typescript
// トップレベルディレクトリ + ルートファイルを監視
const watchTargets = [
  path.join(this.rootDir, 'docs'),
  path.join(this.rootDir, 'packages'),
  path.join(this.rootDir, 'README.md'),
];

chokidar.watch(watchTargets, {
  ignored: (filePath, stats) => {
    // includeパターンに一致しないファイルを除外
    // excludeパターンに一致するファイルを除外
  },
  // ...
});
```

#### 2.3 実装の詳細

**新しいヘルパー関数**:
```typescript
/**
 * includeパターンから監視対象のパスリストを生成
 */
private buildWatchTargets(): string[] {
  const targets = new Set<string>();

  for (const pattern of this.filesConfig.include) {
    if (pattern.includes('**')) {
      // Globパターンの場合、トップレベルディレクトリを抽出
      const topDir = pattern.split('/')[0];
      if (topDir && topDir !== '**') {
        targets.add(path.join(this.rootDir, topDir));
      }
    } else if (pattern.includes('*')) {
      // ワイルドカードの場合、親ディレクトリを監視
      const parentDir = path.dirname(pattern);
      if (parentDir !== '.') {
        targets.add(path.join(this.rootDir, parentDir));
      } else {
        targets.add(this.rootDir);
      }
    } else {
      // 具体的なパスの場合、そのまま追加
      targets.add(path.join(this.rootDir, pattern));
    }
  }

  return Array.from(targets);
}

/**
 * ファイルパスがincludeパターンに一致するか確認
 */
private matchesIncludePattern(filePath: string): boolean {
  const relativePath = path.relative(this.rootDir, filePath);
  return this.filesConfig.include.some(pattern => {
    return minimatch(relativePath, pattern);
  });
}
```

### 3. 監視対象数の調査・エラーチェック機能

**目的**: 監視開始前に対象ファイル数を確認し、過度な監視を防ぐ

**設計方針**:

#### 3.1 設定への閾値追加

```typescript
// WatcherConfig
export interface WatcherConfig {
  // ... 既存のフィールド

  /**
   * 監視対象ファイル数の上限
   * この数を超える場合、Watcherの起動を拒否
   * @default 10000
   */
  maxWatchFiles?: number;

  /**
   * 監視対象ファイル数の警告閾値
   * この数を超える場合、警告を出力
   * @default 5000
   */
  warnWatchFiles?: number;
}
```

#### 3.2 事前調査の実装

```typescript
/**
 * 監視対象のファイル数を調査
 */
private async countWatchTargets(): Promise<{
  totalFiles: number;
  mdFiles: number;
  directories: number;
  largestDirs: Array<{ path: string; count: number }>;
}> {
  const discovery = new FileDiscovery({
    rootDir: this.rootDir,
    config: this.filesConfig,
  });

  const files = await discovery.discoverFiles();

  // 統計情報を収集
  const stats = {
    totalFiles: files.length,
    mdFiles: files.filter(f => f.endsWith('.md')).length,
    directories: new Set(files.map(f => path.dirname(f))).size,
    largestDirs: this.findLargestDirectories(files),
  };

  return stats;
}

/**
 * Watcher起動前のバリデーション
 */
private async validateWatchTargets(): Promise<void> {
  const stats = await this.countWatchTargets();

  const maxFiles = this.watcherConfig.maxWatchFiles ?? 10000;
  const warnFiles = this.watcherConfig.warnWatchFiles ?? 5000;

  if (stats.mdFiles > maxFiles) {
    throw new Error(
      `Too many files to watch: ${stats.mdFiles} .md files found (max: ${maxFiles})\n` +
      `Consider:\n` +
      `1. Adding more exclude patterns to .search-docs.json\n` +
      `2. Using more specific include patterns\n` +
      `3. Setting watcher.enabled = false and using manual indexing\n` +
      `Largest directories:\n${this.formatLargestDirs(stats.largestDirs)}`
    );
  }

  if (stats.mdFiles > warnFiles) {
    console.warn(
      `[FileWatcher] Warning: Watching ${stats.mdFiles} .md files (threshold: ${warnFiles})\n` +
      `This may consume significant system resources.\n` +
      `Consider enabling usePolling or adjusting include/exclude patterns.`
    );
  }

  console.log(
    `[FileWatcher] Watch targets: ${stats.mdFiles} .md files in ${stats.directories} directories`
  );
}
```

#### 3.3 エラーメッセージの充実

ユーザーが問題を解決しやすいように、具体的な情報を提供：

```typescript
throw new Error(
  `Too many files to watch: ${stats.mdFiles} .md files found (max: ${maxFiles})\n` +
  `\n` +
  `Largest directories with .md files:\n` +
  `  - docs/api: 3,452 files\n` +
  `  - docs/reference: 2,103 files\n` +
  `  - packages/legacy: 1,234 files\n` +
  `\n` +
  `Suggested solutions:\n` +
  `1. Add exclude patterns in .search-docs.json:\n` +
  `   "exclude": ["**/legacy/**", "**/api/generated/**"]\n` +
  `\n` +
  `2. Use more specific include patterns:\n` +
  `   "include": ["docs/guides/**/*.md", "README.md"]\n` +
  `\n` +
  `3. Enable polling mode (slower but uses less resources):\n` +
  `   "watcher": { "usePolling": true }\n` +
  `\n` +
  `4. Disable file watching and use manual indexing:\n` +
  `   "watcher": { "enabled": false }\n`
);
```

## 作業計画

### Phase 1: chokidarバージョン確認（30分）

- [ ] 現在のバージョン確認
- [ ] npmで最新バージョン確認
- [ ] changelogでGlobパターンの修正確認
- [ ] 更新可能か判断

### Phase 2: includeベース監視の実装（2-3時間）

- [ ] `buildWatchTargets()`の実装
- [ ] `matchesIncludePattern()`の実装
- [ ] `start()`メソッドの書き換え
- [ ] `ignored`コールバックの更新
- [ ] 既存テストの確認・修正

### Phase 3: 監視対象数チェック機能（1-2時間）

- [ ] `WatcherConfig`に閾値フィールド追加
- [ ] `countWatchTargets()`の実装
- [ ] `validateWatchTargets()`の実装
- [ ] エラーメッセージの作成
- [ ] `start()`でバリデーション実行

### Phase 4: テストとドキュメント（1-2時間）

- [ ] 既存テストの確認
- [ ] 新機能のテスト追加
- [ ] 型チェック
- [ ] ビルド確認
- [ ] task18.md（このファイル）の更新
- [ ] 設定例のドキュメント更新

### 推定作業時間: 4-7時間

## リスク管理

### リスク1: chokidar更新による破壊的変更

**対策**:
- 更新前に現在の動作を記録
- テストで動作確認
- 問題があればロールバック

### リスク2: includeベース監視でイベントが発火しない

**対策**:
- 段階的な実装（まずログ出力で確認）
- テストケースで各パターンを検証
- フォールバックとして現在の実装を残す

### リスク3: 既存の動作への影響

**対策**:
- 既存テストを必ず実行
- 新機能はオプショナルに（デフォルトは現状維持も検討）
- デバッグログの充実

## 完了条件

- [ ] chokidarの最新バージョンを確認・必要に応じて更新
- [ ] includeパターンに基づく監視対象の絞り込みが動作
- [ ] 監視対象数チェック機能が動作
- [ ] 全テストがパス
- [ ] 型チェックがパス
- [ ] ビルドが成功
- [ ] ドキュメントが更新されている

## 作業履歴

- 2025-11-04 14:25: v2作業計画の作成
