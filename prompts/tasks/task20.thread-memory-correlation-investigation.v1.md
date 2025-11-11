# task20: スレッド数とメモリ消費の相関調査

## 目的

スレッド数の増加とメモリ消費の関係を詳細に記録し、スレッド生成がメモリ増加の原因であるか検証する。

## 仮説

- スレッド数は増えるが減らない
- スレッドに紐づくメモリオブジェクトは削除されない
- よってメモリ使用量は増え続ける

## 測定項目

1. **時刻**（秒）
2. **スレッド数**
3. **メモリ消費量**（RSS MB）
4. **リクエスト処理数**（サーバへ問い合わせ）
   - インデックス作成完了数
   - インデックス作成中数
   - 保留中のリクエスト数

## 測定方法

### 1. 監視スクリプトの作成

```bash
#!/bin/bash
# /tmp/monitor-detailed.sh

PID=$1
SERVER_URL=${2:-"http://localhost:53567"}
DURATION=${3:-300}

echo "Time(s),Threads,RSS(MB),VSZ(MB),IndexedDocs,ProcessingDocs,PendingRequests"

START=$(date +%s)
while [ $(($(date +%s) - START)) -lt $DURATION ]; do
  if ! ps -p $PID > /dev/null 2>&1; then
    echo "Process $PID terminated"
    exit 1
  fi

  ELAPSED=$(($(date +%s) - START))

  # スレッド数とメモリ
  THREADS=$(ps -M -p $PID 2>/dev/null | wc -l)
  MEM=$(ps -p $PID -o rss,vsz | tail -1)
  RSS=$(echo $MEM | awk '{print $1/1024}')
  VSZ=$(echo $MEM | awk '{print $2/1024}')

  # サーバステータス取得
  STATUS=$(curl -s -X POST "${SERVER_URL}/rpc" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getIndexStatus","params":{}}' 2>/dev/null)

  # JSONパース（jqを使用）
  if command -v jq > /dev/null 2>&1 && [ -n "$STATUS" ]; then
    INDEXED=$(echo "$STATUS" | jq -r '.result.completedCount // 0')
    PROCESSING=$(echo "$STATUS" | jq -r '.result.processingCount // 0')
    PENDING=$(echo "$STATUS" | jq -r '.result.pendingCount // 0')
  else
    INDEXED="N/A"
    PROCESSING="N/A"
    PENDING="N/A"
  fi

  printf "%d,%d,%.2f,%.2f,%s,%s,%s\n" \
    $ELAPSED $THREADS $RSS $VSZ "$INDEXED" "$PROCESSING" "$PENDING"

  sleep 1
done
```

### 2. 測定手順

1. **large-test-projectの.search-docsディレクトリをクリア**
   ```bash
   rm -rf /path/to/large-test-project/.search-docs
   ```

2. **サーバ起動**
   ```bash
   cd /path/to/large-test-project
   node /Users/naoto.kato/Develop/otolab/search-docs/packages/cli/dist/index.js server start --daemon
   ```

3. **PID確認**
   ```bash
   cat .search-docs/server.pid
   ```

4. **監視開始**（PID確認後すぐに実行）
   ```bash
   /tmp/monitor-detailed.sh <PID> http://localhost:53567 300 > /tmp/thread-memory-log.csv
   ```

5. **ログ保存**
   ```bash
   cp /tmp/thread-memory-log.csv prompts/tasks/logs/task20-measurement-YYYYMMDD-HHMMSS.csv
   ```

### 3. 測定環境

- **プロジェクト**: large-test-project
- **ファイル数**: 102,893 Markdownファイル
- **測定間隔**: 1秒
- **測定時間**: 300秒（5分）
- **Python設定**:
  - PyArrowメモリプール: system
  - スレッド制限: OMP_NUM_THREADS=4等
  - GC: add_sections後に実行
  - Compact: 100回ごと

## 期待される結果

### パターン1: スレッド数とメモリが強く相関
→ スレッド生成がメモリ増加の主要因

### パターン2: リクエスト処理数とメモリが強く相関
→ インデックス作成処理がメモリ増加の主要因

### パターン3: 時間経過のみと相関
→ 他の要因（GC未実行、メモリプールなど）

## 次のステップ

測定結果に基づいて：
1. 相関分析（スレッド数 vs メモリ、処理数 vs メモリ）
2. スレッド生成タイミングの特定
3. スレッド生成元の調査（必要であれば）

---

## 測定ログ

### 測定準備

**日時**: 2025-11-05
**測定者**: AI Assistant

**スクリプト作成**:
```bash
cat > /tmp/monitor-detailed.sh << 'EOF'
[スクリプト内容は上記参照]
EOF
chmod +x /tmp/monitor-detailed.sh
```

**ログ記録ディレクトリ作成**:
```bash
mkdir -p prompts/tasks/logs
```

---

## 実装状況

### Python側（完了）

`packages/db-engine/src/python/worker.py` に`PerformanceLogger`クラスを実装済み:
- 1秒間隔でパフォーマンスログをstderrに出力
- 出力内容:
  - `timestamp`: タイムスタンプ
  - `elapsed`: 経過時間（秒）
  - `threads`: スレッド数
  - `rss_mb`: RSS（MB）
  - `vms_mb`: VMS（MB）
  - `method_calls`: メソッド呼び出し回数（add_sections, search等）
  - `requests`: リクエスト状態（completed, processing, pending）

### TypeScript側（未実装）

`packages/db-engine/src/typescript/index.ts` では現在stderrを単純に`console.error`で出力しているのみ。

**必要な実装**:
1. stderrからJSONログをパース
2. `type: 'performance'`のログを識別
3. CSVファイルに書き出し
   - ファイルパス: `.search-docs/performance-YYYYMMDD-HHMMSS.csv`
   - ヘッダー: `Time(s),Threads,RSS(MB),VMS(MB),MethodCalls(add_sections),MethodCalls(search),Requests(completed),Requests(processing),Requests(pending)`

## 測定手順（実装版）

### 1. large-test-projectのインデックスをクリア

```bash
rm -rf /path/to/large-test-project/.search-docs
```

### 2. サーバを起動（パフォーマンスログ有効化）

```bash
cd /path/to/large-test-project
ENABLE_PERFORMANCE_LOG=1 \
PERFORMANCE_LOG_PATH=/Users/naoto.kato/Develop/otolab/search-docs/prompts/tasks/logs/task20-measurement-$(date +%Y%m%d-%H%M%S).csv \
node /Users/naoto.kato/Develop/otolab/search-docs/packages/cli/dist/index.js server start --daemon
```

### 3. ログの確認

```bash
# サーバログ
tail -f /path/to/large-test-project/.search-docs/server.log

# パフォーマンスログ
tail -f /Users/naoto.kato/Develop/otolab/search-docs/prompts/tasks/logs/task20-measurement-*.csv
```

### 4. 測定完了後、サーバを停止

```bash
cd /path/to/large-test-project
node /Users/naoto.kato/Develop/otolab/search-docs/packages/cli/dist/index.js server stop
```

## 測定実行ログ

### 測定1: large-test-project初回インデックス作成

**日時**: 2025-11-05 12:23
**プロジェクト**: large-test-project（102,893ファイル）
**測定時間**: 74秒
**CSVファイル**: `prompts/tasks/logs/task20-measurement-converted.csv`

#### 測定結果サマリー

| 項目 | 開始時 | 終了時 | 変化量 |
|------|--------|--------|--------|
| 経過時間 | 0.00秒 | 74.38秒 | +74.38秒 |
| スレッド数 | 22 | 97 | +75 (+341%) |
| RSS (MB) | 139.97 | 4321.77 | +4181.80 (+2987%) |
| VMS (MB) | 403090.84 | 416021.02 | +12930.18 (+3.2%) |
| AddSections呼び出し | 0 | 31 | +31 |
| CreateRequest呼び出し | 0 | 1551 | +1551 |
| UpdateRequest呼び出し | 0 | 63 | +63 |

#### 相関分析

**1. スレッド数とメモリの相関**
- スレッド数: 22 → 97 (+341%)
- RSSメモリ: 139.97MB → 4321.77MB (+2987%)
- **強い正の相関が確認された**

**2. リクエスト処理数との相関**
- CreateRequest: 0 → 1551（インデックスリクエスト作成）
- AddSections: 0 → 31（実際のインデックス追加）
- UpdateRequest: 0 → 63（リクエスト更新）

**3. 時系列パターン**
- 0-8秒: スレッド数22-30、RSS 139-690MB（初期化フェーズ）
- 8-70秒: スレッド数急増 30→97、RSS急増 690→4275MB（インデックス作成フェーズ）
- 70-74秒: スレッド数横ばい97、RSS 4275→4321MB（終盤）

## 分析結果

### 主要な発見

1. **スレッド数とメモリ消費の強い相関**
   - スレッド数が3倍以上増加（22→97）
   - メモリ消費が約30倍増加（139MB→4321MB）
   - 相関は非常に強く、スレッド増加がメモリ増加の主要因である可能性が高い

2. **スレッド増加のタイミング**
   - CreateRequestが増加し始めた8秒時点（68リクエスト）でスレッド数が30に増加
   - その後、リクエスト作成が進むにつれてスレッド数が急増
   - 最終的に97スレッドに到達

3. **メモリ増加の特徴**
   - スレッド増加と同期してRSSメモリが急増
   - VMS（仮想メモリ）は約3%増加と小さく、物理メモリ（RSS）の増加が顕著
   - add_sections呼び出しは31回のみで、メモリ増加の主要因ではない

### 仮説の検証

**元の仮説**:
- ✅ スレッド数は増えるが減らない → **確認された**（22→97、減少なし）
- ⚠️ スレッドに紐づくメモリオブジェクトは削除されない → **可能性が高い**
- ✅ よってメモリ使用量は増え続ける → **確認された**（4.3GB到達）

### スレッド急増ポイントの詳細分析

AddSections呼び出しとスレッド増加の関係を詳細に分析した結果:

| 時刻 | スレッド変化 | RSS変化 | AddSections | イベント |
|------|------------|---------|-------------|----------|
| 7-8秒 | 23→30 (+7) | 684→690MB (+6MB) | 0 | CreateRequest開始（68件） |
| **39-40秒** | **32→66 (+34)** | **1163→2550MB (+1386MB)** | **0→1** | **最初のadd_sections呼び出し** |
| 51-52秒 | 70→78 (+8) | 3118→3150MB (+32MB) | 11→13 | add_sections継続中 |
| 65-66秒 | 78→85 (+7) | 3983→4016MB (+33MB) | 23→25 | add_sections継続中 |
| 69-70秒 | 85→97 (+12) | 4164→4190MB (+26MB) | 27→29 | add_sections継続中 |

**最も重要な発見**:
- **最初のadd_sections呼び出し時（39-40秒）にスレッドが34本も急増**
- この時点でRSSメモリも1.4GB急増
- その後もadd_sections呼び出しごとにスレッドが増加し続ける

AddSections呼び出しは約1秒に1回のペースで31回実行され、その間スレッド数は66→97に増加し続けた。

### 結論

**add_sections呼び出しが直接的なスレッド生成のトリガーである**ことが明確に判明。

スレッド数の増加とメモリ消費には **強い正の相関** があり、スレッド生成が メモリリークの主要因である可能性が高い。

### 問題の特定

**正常な動作**:
- 最初のadd_sections呼び出し時: スレッド32→66 (+34)
  - これはLanceDB/PyArrowのワーカースレッドプール初期化と思われる（正常）

**異常な動作**:
- 2回目以降のadd_sections呼び出し: baseline 66 → 最終 97 (+31)
  - **add_sections呼び出し31回に対して、31スレッド増加**
  - **1回のadd_sectionsごとに約1スレッドがリークしている**
  - スレッドが解放されず蓄積し続ける

### 根本原因の仮説

1. **スレッドプールの不適切な管理**
   - 各add_sections呼び出しで新しいスレッドが作成される
   - 作成されたスレッドが適切に終了・回収されない
   - スレッドプールサイズが無制限に増加

2. **可能性のある原因箇所**
   - LanceDBの`table.add()`内部のスレッド管理
   - PyArrowのスレッドプール設定
   - Pythonの並列処理ライブラリ（concurrent.futures等）の不適切な使用

### 次のステップ

以下を優先的に調査すべき:
1. **スレッド生成箇所の特定**（最優先）
   - `worker.py`の`add_sections()`メソッド
   - `table.add(sections)`呼び出し前後でスレッドダンプを取得
   - Pythonの`threading.enumerate()`でアクティブスレッドを確認
2. **LanceDB/PyArrowのスレッドプール設定を確認**
   - 環境変数（`OMP_NUM_THREADS`等）が効いているか
   - LanceDBのバージョンと既知の問題
3. **修正案の検討**
   - スレッドプールの明示的な制限
   - table.add()の呼び出し方法の見直し
   - 定期的なスレッドクリーンアップ
