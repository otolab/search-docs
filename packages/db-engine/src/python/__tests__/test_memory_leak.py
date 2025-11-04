"""
メモリリークテスト

各機能のメモリ使用量を測定し、リークがないことを確認する。
特にインデックス作成周りを重点的にテスト。
"""

import pytest
import gc
import tracemalloc
import sys
import os
import tempfile
import shutil
from pathlib import Path

# worker.pyをインポートできるようにパスを追加
sys.path.insert(0, str(Path(__file__).parent.parent))

from worker import SearchDocsWorker


def create_test_section(section_id, doc_id, content_base, **overrides):
    """テスト用のセクションデータを作成"""
    from datetime import datetime
    section = {
        "id": section_id,
        "document_path": f"doc-{doc_id}.md",
        "heading": f"Heading {section_id}",
        "depth": 1,
        "content": content_base,
        "token_count": 50,
        "parent_id": None,
        "order": 0,
        "is_dirty": False,
        "document_hash": f"hash-{doc_id}",
        "start_line": 1,
        "end_line": 10,
        "section_number": [1, 0, 0],
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
    }
    section.update(overrides)
    return section


class TestMemoryLeak:
    """メモリリークテスト"""

    @pytest.fixture
    def temp_db(self):
        """一時的なDBディレクトリを作成"""
        temp_dir = tempfile.mkdtemp()
        yield temp_dir
        shutil.rmtree(temp_dir)

    @pytest.fixture
    def worker(self, temp_db):
        """テスト用のワーカーインスタンス"""
        worker = SearchDocsWorker(db_path=temp_db)
        yield worker
        # クリーンアップ
        del worker
        gc.collect()

    def get_memory_usage(self):
        """現在のメモリ使用量を取得（バイト単位）"""
        gc.collect()  # GCを実行してから測定
        current, peak = tracemalloc.get_traced_memory()
        return current

    def test_add_sections_memory_leak(self, worker):
        """add_sections()のメモリリークテスト"""
        tracemalloc.start()

        # 初期状態のメモリ
        gc.collect()
        initial_memory = self.get_memory_usage()

        # テストデータ作成（100セクション）
        sections = []
        for i in range(100):
            section = create_test_section(
                f"test-{i}",
                i % 10,
                f"Content {i} " * 100,
                depth=i % 4,
                token_count=100,
                order=i,
                section_number=[1, i % 10, i % 5],
            )
            sections.append(section)

        # セクション追加
        worker.add_sections({"sections": sections})

        # 追加直後のメモリ
        after_add_memory = self.get_memory_usage()

        # データをクリア
        del sections
        gc.collect()

        # GC後のメモリ
        after_gc_memory = self.get_memory_usage()

        tracemalloc.stop()

        # メモリ増加を確認
        memory_increase_mb = (after_gc_memory - initial_memory) / 1024 / 1024

        print(f"\n=== add_sections Memory Test ===")
        print(f"Initial memory: {initial_memory / 1024 / 1024:.2f} MB")
        print(f"After add: {after_add_memory / 1024 / 1024:.2f} MB")
        print(f"After GC: {after_gc_memory / 1024 / 1024:.2f} MB")
        print(f"Net increase: {memory_increase_mb:.2f} MB")

        # データがDBに保存されるため、ある程度のメモリ増加は許容
        # しかし、100セクション程度なら10MB以内に収まるべき
        assert memory_increase_mb < 10, f"Memory leak detected: {memory_increase_mb:.2f} MB increase"

    def test_search_memory_leak(self, worker):
        """search()のメモリリークテスト"""
        tracemalloc.start()

        # テストデータ準備
        sections = []
        for i in range(50):
            section = create_test_section(
                f"search-test-{i}",
                i % 5,
                f"Searchable content {i} " * 50,
                order=i,
            )
            sections.append(section)
        worker.add_sections({"sections": sections})
        del sections
        gc.collect()

        # 初期メモリ
        initial_memory = self.get_memory_usage()

        # 検索を複数回実行
        for _ in range(10):
            result = worker.search({"query": "content", "limit": 10})
            del result

        gc.collect()

        # GC後のメモリ
        after_search_memory = self.get_memory_usage()

        tracemalloc.stop()

        memory_increase_mb = (after_search_memory - initial_memory) / 1024 / 1024

        print(f"\n=== search Memory Test ===")
        print(f"Initial memory: {initial_memory / 1024 / 1024:.2f} MB")
        print(f"After 10 searches + GC: {after_search_memory / 1024 / 1024:.2f} MB")
        print(f"Net increase: {memory_increase_mb:.2f} MB")

        # 検索10回でメモリが5MB以上増えたらリーク疑い
        assert memory_increase_mb < 5, f"Memory leak detected: {memory_increase_mb:.2f} MB increase"

    def test_get_stats_memory_leak(self, worker):
        """get_stats()のメモリリークテスト"""
        tracemalloc.start()

        # 大量のセクションを追加
        sections = []
        for i in range(1000):
            section = create_test_section(
                f"stats-test-{i}",
                i % 100,
                f"Stats content {i} " * 20,
                depth=i % 4,
                token_count=20,
                order=i,
                is_dirty=i % 10 == 0,
                section_number=[1, i % 100, i % 10],
            )
            sections.append(section)
        worker.add_sections({"sections": sections})
        del sections
        gc.collect()

        # 初期メモリ
        initial_memory = self.get_memory_usage()

        # get_statsを複数回実行
        for _ in range(5):
            stats = worker.get_stats()
            del stats

        gc.collect()

        # GC後のメモリ
        after_stats_memory = self.get_memory_usage()

        tracemalloc.stop()

        memory_increase_mb = (after_stats_memory - initial_memory) / 1024 / 1024

        print(f"\n=== get_stats Memory Test ===")
        print(f"Initial memory: {initial_memory / 1024 / 1024:.2f} MB")
        print(f"After 5 get_stats + GC: {after_stats_memory / 1024 / 1024:.2f} MB")
        print(f"Net increase: {memory_increase_mb:.2f} MB")

        # get_statsを5回実行してメモリが3MB以上増えたらリーク
        assert memory_increase_mb < 3, f"Memory leak detected: {memory_increase_mb:.2f} MB increase"

    def test_index_creation_memory_leak(self, worker):
        """インデックス作成のメモリリークテスト（重点テスト）"""
        tracemalloc.start()

        # 初期メモリ
        initial_memory = self.get_memory_usage()

        # 大規模なインデックス作成をシミュレート
        # 100個の文書、各10セクション = 1000セクション
        for doc_id in range(100):
            sections = []
            for sec_id in range(10):
                section = create_test_section(
                    f"index-doc{doc_id}-sec{sec_id}",
                    doc_id,
                    f"Index content for doc {doc_id} section {sec_id} " * 50,
                    depth=sec_id % 4,
                    order=sec_id,
                    section_number=[1, doc_id, sec_id],
                )
                sections.append(section)

            # セクション追加
            worker.add_sections({"sections": sections})

            # 明示的にクリーンアップ
            del sections
            gc.collect()

        # 全追加後のメモリ
        after_index_memory = self.get_memory_usage()

        tracemalloc.stop()

        memory_increase_mb = (after_index_memory - initial_memory) / 1024 / 1024

        print(f"\n=== Index Creation Memory Test ===")
        print(f"Initial memory: {initial_memory / 1024 / 1024:.2f} MB")
        print(f"After creating 1000 sections (100 docs): {after_index_memory / 1024 / 1024:.2f} MB")
        print(f"Net increase: {memory_increase_mb:.2f} MB")

        # 1000セクションのインデックス作成で50MB以内に収まるべき
        assert memory_increase_mb < 50, f"Memory leak detected: {memory_increase_mb:.2f} MB increase"

    def test_repeated_operations_memory_stability(self, worker):
        """繰り返し操作でのメモリ安定性テスト"""
        tracemalloc.start()

        # 初期メモリ
        gc.collect()
        initial_memory = self.get_memory_usage()

        # 同じ操作を繰り返す
        for iteration in range(10):
            # セクション追加
            sections = []
            for i in range(10):
                section = create_test_section(
                    f"repeat-iter{iteration}-{i}",
                    iteration,
                    f"Repeat content {iteration}-{i} " * 20,
                    order=i,
                    section_number=[1, iteration, i],
                )
                sections.append(section)
            worker.add_sections({"sections": sections})
            del sections

            # 検索
            result = worker.search({"query": "content", "limit": 5})
            del result

            # 統計取得
            stats = worker.get_stats()
            del stats

            gc.collect()

        # 最終メモリ
        final_memory = self.get_memory_usage()

        tracemalloc.stop()

        memory_increase_mb = (final_memory - initial_memory) / 1024 / 1024

        print(f"\n=== Repeated Operations Memory Test ===")
        print(f"Initial memory: {initial_memory / 1024 / 1024:.2f} MB")
        print(f"After 10 iterations (add + search + stats): {final_memory / 1024 / 1024:.2f} MB")
        print(f"Net increase: {memory_increase_mb:.2f} MB")

        # 繰り返し操作で20MB以内に収まるべき
        assert memory_increase_mb < 20, f"Memory leak detected: {memory_increase_mb:.2f} MB increase"


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
