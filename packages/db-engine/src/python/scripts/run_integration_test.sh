#!/bin/bash
# task23統合テストランナー
# 処理時間とメモリ使用量を記録しながらインデックス処理を実行

set -e

# ローカルビルド版のCLIを使用（グローバル版ではなく）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# SCRIPT_DIR = packages/db-engine/src/python/scripts
# ../../../.. = packages/db-engine/src/python -> packages/db-engine/src -> packages/db-engine -> packages -> search-docs
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
LOCAL_CLI="node $PROJECT_ROOT/packages/cli/dist/index.js"

echo "Using local CLI: $LOCAL_CLI"

# 引数チェック
if [ $# -lt 1 ]; then
    echo "Usage: $0 <test-data-dir> [output-dir]"
    echo "Example: $0 /private/tmp/task23-test-data/pattern-a"
    exit 1
fi

TEST_DATA_DIR="$1"
OUTPUT_DIR="${2:-/private/tmp/task23-results}"

# ディレクトリ存在チェック
if [ ! -d "$TEST_DATA_DIR" ]; then
    echo "Error: Test data directory not found: $TEST_DATA_DIR"
    exit 1
fi

# 出力ディレクトリ作成
mkdir -p "$OUTPUT_DIR"

# テスト名（ディレクトリ名から抽出）
TEST_NAME=$(basename "$TEST_DATA_DIR")
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULT_PREFIX="${OUTPUT_DIR}/${TEST_NAME}_${TIMESTAMP}"

echo "========================================="
echo "task23 Integration Test"
echo "========================================="
echo "Test: $TEST_NAME"
echo "Data: $TEST_DATA_DIR"
echo "Output: $RESULT_PREFIX"
echo "========================================="

# 既存のsearch-docsプロセスをチェック
if pgrep -f "search-docs.*server" > /dev/null; then
    echo "Warning: search-docs server is already running"
    echo "Stopping existing server..."
    cd "$TEST_DATA_DIR"
    $LOCAL_CLI server stop || true
    sleep 2
fi

# search-docsのインデックスをクリーン
if [ -d "$TEST_DATA_DIR/.search-docs" ]; then
    echo "Cleaning existing index..."
    rm -rf "$TEST_DATA_DIR/.search-docs"
fi

# メモリ監視を開始（バックグラウンド）
echo "Starting memory monitor..."
MONITOR_PID=""
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
python3 "$SCRIPT_DIR/monitor_memory.py" \
    --output "${RESULT_PREFIX}_memory.csv" \
    --interval 1.0 &
MONITOR_PID=$!
echo "Memory monitor PID: $MONITOR_PID"

# トラップでクリーンアップ
cleanup() {
    echo ""
    echo "Cleaning up..."
    if [ -n "$MONITOR_PID" ]; then
        kill $MONITOR_PID 2>/dev/null || true
    fi
    cd "$TEST_DATA_DIR"
    $LOCAL_CLI server stop 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 開始時刻
START_TIME=$(date +%s)
START_TIME_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo ""
echo "Starting index rebuild at $START_TIME_ISO..."
echo ""

# search-docsでインデックス処理を実行
cd "$TEST_DATA_DIR"

# PerformanceLoggerを有効化
export ENABLE_PERFORMANCE_LOG=1
export PERFORMANCE_LOG_PATH="${RESULT_PREFIX}_performance.csv"

# サーバ起動＋インデックス処理
# ログを保存（デフォルトでdaemon動作）
$LOCAL_CLI server start 2>&1 | tee "${RESULT_PREFIX}_server.log"

# サーバが起動するまで待機
echo "Waiting for server to start and DBEngine to initialize..."
sleep 10

# DBEngineの初期化を待つ
echo "Checking DBEngine status..."
for i in {1..10}; do
    if $LOCAL_CLI index status 2>&1 | grep -v "Error: Not connected to database" > /dev/null; then
        echo "DBEngine is ready"
        break
    fi
    echo "Waiting for DBEngine... ($i/10)"
    sleep 2
done

# インデックスステータスを確認
echo "Index status:"
$LOCAL_CLI index status 2>&1 | tee -a "${RESULT_PREFIX}_server.log"

# インデックスリビルド実行
echo ""
echo "Running index rebuild..."
$LOCAL_CLI index rebuild 2>&1 | tee -a "${RESULT_PREFIX}_server.log"

# IndexWorkerのキューが空になるまで待機
echo ""
echo "Waiting for IndexWorker to complete..."
for i in {1..60}; do
    QUEUE_COUNT=$($LOCAL_CLI index status 2>&1 | grep -A 10 "Worker:" | grep "Queue:" | awk '{print $2}')
    if [ "$QUEUE_COUNT" = "0" ]; then
        echo "IndexWorker queue is empty"
        break
    fi
    echo "Waiting... Queue: $QUEUE_COUNT ($i/60)"
    sleep 5
done

# 終了時刻
END_TIME=$(date +%s)
END_TIME_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
DURATION=$((END_TIME - START_TIME))

echo ""
echo "Index rebuild completed at $END_TIME_ISO"
echo "Duration: ${DURATION}s"

# 最終ステータス
echo ""
echo "Final index status:"
$LOCAL_CLI index status 2>&1 | tee -a "${RESULT_PREFIX}_server.log"

# サーバ停止
echo ""
echo "Stopping server..."
$LOCAL_CLI server stop 2>&1 | tee -a "${RESULT_PREFIX}_server.log"

# メモリ監視停止
echo "Stopping memory monitor..."
if [ -n "$MONITOR_PID" ]; then
    kill $MONITOR_PID 2>/dev/null || true
fi

# サマリ作成
echo ""
echo "Creating summary..."
cat > "${RESULT_PREFIX}_summary.txt" <<EOF
========================================
task23 Integration Test Summary
========================================

Test Name: $TEST_NAME
Test Data: $TEST_DATA_DIR
Timestamp: $TIMESTAMP

Start Time: $START_TIME_ISO
End Time: $END_TIME_ISO
Duration: ${DURATION}s ($(($DURATION / 60))m $(($DURATION % 60))s)

Output Files:
- Memory Log: ${RESULT_PREFIX}_memory.csv
- Performance Log: ${RESULT_PREFIX}_performance.csv
- Server Log: ${RESULT_PREFIX}_server.log
- Summary: ${RESULT_PREFIX}_summary.txt

========================================
EOF

cat "${RESULT_PREFIX}_summary.txt"

echo ""
echo "✓ Test completed successfully!"
echo "Results saved to: ${RESULT_PREFIX}_*"
