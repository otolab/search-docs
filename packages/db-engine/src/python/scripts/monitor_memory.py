#!/usr/bin/env python3
"""
task23用のメモリ監視スクリプト

search-docsサーバプロセスとPythonワーカーのメモリ使用量を監視し、
CSV形式で記録する。
"""

import argparse
import csv
import time
import sys
from datetime import datetime
from pathlib import Path
from typing import List, Optional

try:
    import psutil
except ImportError:
    print("Error: psutil not found. Install with: pip install psutil", file=sys.stderr)
    sys.exit(1)


def find_search_docs_processes() -> List[psutil.Process]:
    """search-docs関連プロセスを検索

    Returns:
        検出されたプロセスのリスト
    """
    processes = []

    for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
        try:
            cmdline = proc.info.get('cmdline')
            if not cmdline:
                continue

            cmdline_str = ' '.join(cmdline)

            # search-docsサーバまたはPythonワーカーを検出
            if 'search-docs' in cmdline_str or 'worker.py' in cmdline_str:
                processes.append(proc)

        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    return processes


def get_process_info(proc: psutil.Process) -> dict:
    """プロセス情報を取得

    Args:
        proc: psutilプロセスオブジェクト

    Returns:
        プロセス情報の辞書
    """
    try:
        mem_info = proc.memory_info()
        cpu_percent = proc.cpu_percent(interval=0.1)

        return {
            'pid': proc.pid,
            'name': proc.name(),
            'rss_mb': round(mem_info.rss / 1024 / 1024, 2),
            'vms_mb': round(mem_info.vms / 1024 / 1024, 2),
            'cpu_percent': round(cpu_percent, 2),
            'num_threads': proc.num_threads(),
        }
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return None


def monitor_memory(
    output_file: Optional[Path] = None,
    interval: float = 1.0,
    duration: Optional[int] = None
):
    """メモリ使用量を監視

    Args:
        output_file: 出力CSVファイルパス（Noneの場合は標準出力）
        interval: 監視間隔（秒）
        duration: 監視時間（秒、Noneの場合は無制限）
    """
    print(f"Starting memory monitoring (interval={interval}s)...", file=sys.stderr)

    # CSVライターを初期化
    if output_file:
        csv_file = open(output_file, 'w', newline='')
        output = csv_file
    else:
        csv_file = None
        output = sys.stdout

    writer = csv.writer(output)

    # ヘッダー
    writer.writerow([
        'timestamp',
        'elapsed_sec',
        'pid',
        'name',
        'rss_mb',
        'vms_mb',
        'cpu_percent',
        'num_threads'
    ])

    start_time = time.time()
    iteration = 0

    try:
        while True:
            elapsed = time.time() - start_time

            # 時間制限チェック
            if duration and elapsed > duration:
                break

            # プロセスを検索
            processes = find_search_docs_processes()

            if not processes:
                print(f"[{elapsed:.1f}s] No search-docs processes found", file=sys.stderr)
                time.sleep(interval)
                continue

            # 各プロセスの情報を記録
            timestamp = datetime.now().isoformat()

            for proc in processes:
                info = get_process_info(proc)
                if info:
                    writer.writerow([
                        timestamp,
                        round(elapsed, 2),
                        info['pid'],
                        info['name'],
                        info['rss_mb'],
                        info['vms_mb'],
                        info['cpu_percent'],
                        info['num_threads']
                    ])

            # フラッシュ
            output.flush()

            # 進捗表示
            iteration += 1
            if iteration % 10 == 0:
                total_rss = sum(get_process_info(p)['rss_mb'] for p in processes if get_process_info(p))
                print(f"[{elapsed:.1f}s] Monitoring {len(processes)} processes, total RSS: {total_rss:.2f} MB", file=sys.stderr)

            time.sleep(interval)

    except KeyboardInterrupt:
        print("\nMonitoring stopped by user", file=sys.stderr)

    finally:
        if csv_file:
            csv_file.close()
            print(f"\n✓ Memory log saved to: {output_file}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Monitor search-docs memory usage")
    parser.add_argument(
        "--output",
        type=Path,
        help="Output CSV file path (default: stdout)"
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=1.0,
        help="Monitoring interval in seconds (default: 1.0)"
    )
    parser.add_argument(
        "--duration",
        type=int,
        help="Monitoring duration in seconds (default: unlimited)"
    )

    args = parser.parse_args()

    # 初期プロセスチェック
    processes = find_search_docs_processes()
    if not processes:
        print("Warning: No search-docs processes found at startup", file=sys.stderr)
        print("The monitor will wait for processes to appear...", file=sys.stderr)

    monitor_memory(
        output_file=args.output,
        interval=args.interval,
        duration=args.duration
    )


if __name__ == "__main__":
    main()
