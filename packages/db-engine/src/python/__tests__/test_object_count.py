"""
オブジェクト数測定テスト

処理回数に比例してオブジェクト数が増えるかを確認し、リークを検出する。
"""

import pytest
import gc
import sys
import tempfile
import shutil
from pathlib import Path
from collections import Counter

# worker.pyをインポートできるようにパスを追加
sys.path.insert(0, str(Path(__file__).parent.parent))

from worker import SearchDocsWorker
from datetime import datetime


def create_test_section(section_id, doc_id, content_base, **overrides):
    """テスト用のセクションデータを作成"""
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


class TestObjectCount:
    """オブジェクト数測定によるリーク検出テスト"""

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

    def get_object_count(self):
        """現在のオブジェクト数を取得"""
        gc.collect()  # GCを実行してから測定
        return len(gc.get_objects())

    def get_object_types_count(self, top_n=20):
        """型別のオブジェクト数を取得"""
        gc.collect()
        type_counts = Counter(type(obj).__name__ for obj in gc.get_objects())
        return type_counts.most_common(top_n)

    def count_objects_by_type(self, typename):
        """特定の型のオブジェクト数を数える"""
        gc.collect()
        return sum(1 for obj in gc.get_objects() if type(obj).__name__ == typename)

    def test_add_sections_object_leak_1_vs_10(self, worker):
        """add_sections: 1回 vs 10回のオブジェクト増加数比較"""

        # === 1回実行 ===
        gc.collect()
        before_1 = self.get_object_count()

        sections = [create_test_section(f"test-1-{i}", 0, f"Content {i} " * 50) for i in range(10)]
        worker.add_sections({"sections": sections})
        del sections

        gc.collect()
        after_1 = self.get_object_count()
        increase_1 = after_1 - before_1

        # ワーカーをリセット（新しいDBで再作成）
        del worker
        gc.collect()

        temp_dir = tempfile.mkdtemp()
        worker = SearchDocsWorker(db_path=temp_dir)

        # === 10回実行 ===
        gc.collect()
        before_10 = self.get_object_count()

        for iteration in range(10):
            sections = [create_test_section(f"test-10-{iteration}-{i}", iteration, f"Content {i} " * 50) for i in range(10)]
            worker.add_sections({"sections": sections})
            del sections
            gc.collect()

        gc.collect()
        after_10 = self.get_object_count()
        increase_10 = after_10 - before_10

        # クリーンアップ
        del worker
        shutil.rmtree(temp_dir)

        print(f"\n=== add_sections Object Count Test ===")
        print(f"1回実行:")
        print(f"  Before: {before_1}")
        print(f"  After:  {after_1}")
        print(f"  Increase: {increase_1}")
        print(f"\n10回実行:")
        print(f"  Before: {before_10}")
        print(f"  After:  {after_10}")
        print(f"  Increase: {increase_10}")
        print(f"\n比率: {increase_10 / increase_1 if increase_1 > 0 else 'N/A':.2f}x")

        # リークの判定
        # 10回実行で増加数が1回実行の3倍以上ならリーク疑い
        if increase_1 > 0:
            ratio = increase_10 / increase_1
            assert ratio < 3.0, f"Object leak detected: 10x execution increased objects by {ratio:.2f}x (expected < 3.0x)"

    def test_search_object_leak_1_vs_10(self, worker):
        """search: 1回 vs 10回のオブジェクト増加数比較"""

        # テストデータ準備
        sections = [create_test_section(f"search-{i}", i % 5, f"Searchable content {i} " * 50) for i in range(50)]
        worker.add_sections({"sections": sections})
        del sections
        gc.collect()

        # === 1回実行 ===
        gc.collect()
        before_1 = self.get_object_count()

        result = worker.search({"query": "content", "limit": 10})
        del result

        gc.collect()
        after_1 = self.get_object_count()
        increase_1 = after_1 - before_1

        # === 10回実行 ===
        gc.collect()
        before_10 = self.get_object_count()

        for _ in range(10):
            result = worker.search({"query": "content", "limit": 10})
            del result
            gc.collect()

        gc.collect()
        after_10 = self.get_object_count()
        increase_10 = after_10 - before_10

        print(f"\n=== search Object Count Test ===")
        print(f"1回実行: {increase_1} objects")
        print(f"10回実行: {increase_10} objects")
        print(f"比率: {increase_10 / increase_1 if increase_1 != 0 else 'N/A':.2f}x")

        # 10回実行で増加数が1回実行の3倍以上ならリーク疑い
        if increase_1 > 0:
            ratio = increase_10 / increase_1
            assert ratio < 3.0, f"Object leak detected: {ratio:.2f}x increase"

    def test_get_stats_object_leak_1_vs_10(self, worker):
        """get_stats: 1回 vs 10回のオブジェクト増加数比較"""

        # テストデータ準備
        sections = [
            create_test_section(f"stats-{i}", i % 10, f"Stats content {i} " * 20, is_dirty=i % 5 == 0)
            for i in range(100)
        ]
        worker.add_sections({"sections": sections})
        del sections
        gc.collect()

        # === 1回実行 ===
        gc.collect()
        before_1 = self.get_object_count()

        stats = worker.get_stats()
        del stats

        gc.collect()
        after_1 = self.get_object_count()
        increase_1 = after_1 - before_1

        # === 10回実行 ===
        gc.collect()
        before_10 = self.get_object_count()

        for _ in range(10):
            stats = worker.get_stats()
            del stats
            gc.collect()

        gc.collect()
        after_10 = self.get_object_count()
        increase_10 = after_10 - before_10

        print(f"\n=== get_stats Object Count Test ===")
        print(f"1回実行: {increase_1} objects")
        print(f"10回実行: {increase_10} objects")
        print(f"比率: {increase_10 / increase_1 if increase_1 != 0 else 'N/A':.2f}x")

        if increase_1 > 0:
            ratio = increase_10 / increase_1
            assert ratio < 3.0, f"Object leak detected: {ratio:.2f}x increase"

    def test_dataframe_objects_after_get_stats(self, worker):
        """get_stats後にDataFrameオブジェクトが残っていないか確認"""

        # テストデータ準備
        sections = [create_test_section(f"df-test-{i}", i % 10, f"Content {i} " * 20) for i in range(100)]
        worker.add_sections({"sections": sections})
        del sections
        gc.collect()

        # 処理前のDataFrame数
        before_df_count = self.count_objects_by_type('DataFrame')

        # get_statsを実行
        stats = worker.get_stats()
        del stats
        gc.collect()

        # 処理後のDataFrame数
        after_df_count = self.count_objects_by_type('DataFrame')

        print(f"\n=== DataFrame Count Test ===")
        print(f"Before: {before_df_count} DataFrames")
        print(f"After:  {after_df_count} DataFrames")
        print(f"Leaked: {after_df_count - before_df_count} DataFrames")

        # DataFrameが増えていたらリーク
        assert after_df_count <= before_df_count, f"DataFrame leak: {after_df_count - before_df_count} objects remained"

    def test_show_top_object_types_after_operations(self, worker):
        """各操作後の型別オブジェクト数を表示（デバッグ用）"""

        # テストデータ準備
        sections = [create_test_section(f"type-test-{i}", i % 10, f"Content {i} " * 20) for i in range(50)]
        worker.add_sections({"sections": sections})
        del sections
        gc.collect()

        print(f"\n=== Top Object Types After add_sections ===")
        for typename, count in self.get_object_types_count(10):
            print(f"  {typename}: {count}")

        # 検索実行
        for _ in range(5):
            result = worker.search({"query": "content", "limit": 10})
            del result
        gc.collect()

        print(f"\n=== Top Object Types After 5x search ===")
        for typename, count in self.get_object_types_count(10):
            print(f"  {typename}: {count}")

        # 統計取得
        for _ in range(5):
            stats = worker.get_stats()
            del stats
        gc.collect()

        print(f"\n=== Top Object Types After 5x get_stats ===")
        for typename, count in self.get_object_types_count(10):
            print(f"  {typename}: {count}")

    def test_large_scale_add_sections_100_iterations(self, worker):
        """add_sections: 100回繰り返してリークを確認"""

        gc.collect()
        initial_objects = self.get_object_count()

        # 100回繰り返し
        for iteration in range(100):
            sections = [create_test_section(f"large-{iteration}-{i}", iteration, f"Content {i} " * 50) for i in range(10)]
            worker.add_sections({"sections": sections})
            del sections
            if iteration % 10 == 9:  # 10回ごとにGC
                gc.collect()

        gc.collect()
        final_objects = self.get_object_count()
        increase = final_objects - initial_objects

        print(f"\n=== Large Scale add_sections (100 iterations) ===")
        print(f"Initial objects: {initial_objects}")
        print(f"Final objects:   {final_objects}")
        print(f"Increase:        {increase}")
        print(f"Per iteration:   {increase / 100:.2f}")

        # 100回で10万オブジェクト以上増えたらリーク疑い（1回あたり1000オブジェクト）
        assert increase < 100000, f"Possible leak: {increase} objects increased ({increase/100:.2f} per iteration)"

    def test_large_scale_search_1000_iterations(self, worker):
        """search: 1000回繰り返してリークを確認"""

        # テストデータ準備
        sections = [create_test_section(f"search-large-{i}", i % 10, f"Searchable {i} " * 50) for i in range(100)]
        worker.add_sections({"sections": sections})
        del sections
        gc.collect()

        initial_objects = self.get_object_count()

        # 1000回検索
        for iteration in range(1000):
            result = worker.search({"query": "content", "limit": 10})
            del result
            if iteration % 100 == 99:  # 100回ごとにGC
                gc.collect()

        gc.collect()
        final_objects = self.get_object_count()
        increase = final_objects - initial_objects

        print(f"\n=== Large Scale search (1000 iterations) ===")
        print(f"Initial objects: {initial_objects}")
        print(f"Final objects:   {final_objects}")
        print(f"Increase:        {increase}")
        print(f"Per iteration:   {increase / 1000:.2f}")

        # 1000回で1万オブジェクト以上増えたらリーク疑い（1回あたり10オブジェクト）
        assert increase < 10000, f"Possible leak: {increase} objects increased ({increase/1000:.2f} per iteration)"

    def test_large_scale_get_stats_1000_iterations(self, worker):
        """get_stats: 1000回繰り返してリークを確認"""

        # テストデータ準備
        sections = [create_test_section(f"stats-large-{i}", i % 10, f"Stats {i} " * 20) for i in range(100)]
        worker.add_sections({"sections": sections})
        del sections
        gc.collect()

        initial_objects = self.get_object_count()

        # 1000回統計取得
        for iteration in range(1000):
            stats = worker.get_stats()
            del stats
            if iteration % 100 == 99:  # 100回ごとにGC
                gc.collect()

        gc.collect()
        final_objects = self.get_object_count()
        increase = final_objects - initial_objects

        print(f"\n=== Large Scale get_stats (1000 iterations) ===")
        print(f"Initial objects: {initial_objects}")
        print(f"Final objects:   {final_objects}")
        print(f"Increase:        {increase}")
        print(f"Per iteration:   {increase / 1000:.2f}")

        # 1000回で1万オブジェクト以上増えたらリーク疑い
        assert increase < 10000, f"Possible leak: {increase} objects increased ({increase/1000:.2f} per iteration)"

    def test_lancedb_external_object_leak(self, worker):
        """LanceDB外部から見たリーク確認（大規模データ+大量クエリ）"""

        # 大量のテストデータを準備（1000セクション）
        sections = [create_test_section(f"lancedb-{i}", i % 50, f"LanceDB content {i} " * 50) for i in range(1000)]
        worker.add_sections({"sections": sections})
        del sections
        gc.collect()

        # 初期オブジェクト数
        initial_objects = self.get_object_count()

        # 1000回のクエリを実行（検索、統計、条件付き検索を混在）
        for iteration in range(1000):
            if iteration % 3 == 0:
                # 検索
                result = worker.search({"query": "content", "limit": 10})
                del result
            elif iteration % 3 == 1:
                # 統計取得
                stats = worker.get_stats()
                del stats
            else:
                # パス指定検索
                sections = worker.get_sections_by_path({"documentPath": f"doc-{iteration % 50}.md"})
                del sections

            if iteration % 100 == 99:
                gc.collect()

        gc.collect()
        final_objects = self.get_object_count()
        increase = final_objects - initial_objects

        print(f"\n=== LanceDB External Leak Test (1000 mixed queries) ===")
        print(f"Initial objects: {initial_objects}")
        print(f"Final objects:   {final_objects}")
        print(f"Increase:        {increase}")
        print(f"Per iteration:   {increase / 1000:.2f}")

        # 1000回で1万オブジェクト以上増えたらリーク疑い
        assert increase < 10000, f"LanceDB leak detected: {increase} objects ({increase/1000:.2f} per iteration)"

    def test_transformers_external_object_leak(self, worker):
        """Transformers (埋め込みモデル) 外部から見たリーク確認"""

        # モデル初期化
        if not worker.embedding_model.is_loaded:
            worker.embedding_model.initialize()

        gc.collect()
        initial_objects = self.get_object_count()

        # 1000回の埋め込み生成
        for iteration in range(1000):
            # 様々な長さのテキストで埋め込み生成
            if iteration % 3 == 0:
                text = f"Short text {iteration}"
            elif iteration % 3 == 1:
                text = f"Medium length text {iteration} " * 20
            else:
                text = f"Long text content {iteration} " * 100

            vector = worker.embedding_model.encode(text, worker.vector_dimension)
            del vector
            del text

            if iteration % 100 == 99:
                gc.collect()

        gc.collect()
        final_objects = self.get_object_count()
        increase = final_objects - initial_objects

        print(f"\n=== Transformers External Leak Test (1000 encodings) ===")
        print(f"Initial objects: {initial_objects}")
        print(f"Final objects:   {final_objects}")
        print(f"Increase:        {increase}")
        print(f"Per iteration:   {increase / 1000:.2f}")

        # 1000回で1万オブジェクト以上増えたらリーク疑い
        assert increase < 10000, f"Transformers leak detected: {increase} objects ({increase/1000:.2f} per iteration)"


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
