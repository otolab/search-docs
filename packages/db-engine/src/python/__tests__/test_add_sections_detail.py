"""
add_sections詳細調査
セクション追加時のオブジェクト増加を段階的に確認
"""

import pytest
import gc
import sys
import tempfile
import shutil
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent.parent))

from worker import SearchDocsWorker


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


@pytest.fixture
def temp_db():
    """一時的なDBディレクトリを作成"""
    temp_dir = tempfile.mkdtemp()
    yield temp_dir
    shutil.rmtree(temp_dir)


@pytest.fixture
def worker(temp_db):
    """テスト用のワーカーインスタンス"""
    worker = SearchDocsWorker(db_path=temp_db)
    yield worker
    del worker
    gc.collect()


def get_object_count():
    """現在のオブジェクト数を取得"""
    gc.collect()
    return len(gc.get_objects())


def test_add_sections_incremental_check(worker):
    """add_sections: 段階的なオブジェクト増加を確認"""

    gc.collect()
    initial = get_object_count()
    print(f"\n初期オブジェクト数: {initial}")

    checkpoints = [1, 5, 10, 20, 50, 100]
    prev_count = initial

    for i in range(100):
        sections = [create_test_section(f"inc-{i}-{j}", i, f"Content {j} " * 50) for j in range(10)]
        worker.add_sections({"sections": sections})
        del sections
        gc.collect()

        if (i + 1) in checkpoints:
            current = get_object_count()
            increase = current - prev_count
            total_increase = current - initial
            print(f"\n{i+1}回実行後:")
            print(f"  現在のオブジェクト数: {current}")
            print(f"  前回からの増加: {increase}")
            print(f"  初期からの総増加: {total_increase}")
            print(f"  1回あたりの平均増加: {total_increase / (i+1):.2f}")
            prev_count = current


def test_add_sections_then_search(worker):
    """add_sections後にsearch実行してオブジェクトが増えないか確認"""

    # 100セクション追加
    sections = [create_test_section(f"test-{i}", 0, f"Content {i} " * 50) for i in range(100)]
    worker.add_sections({"sections": sections})
    del sections
    gc.collect()

    initial = get_object_count()
    print(f"\nadd_sections後のオブジェクト数: {initial}")

    # 10回検索
    for i in range(10):
        result = worker.search({"query": "content", "limit": 10})
        del result
        gc.collect()

    after_search = get_object_count()
    increase = after_search - initial

    print(f"10回search後のオブジェクト数: {after_search}")
    print(f"増加数: {increase}")

    assert increase < 100, f"search後に{increase}オブジェクト増加 - add_sectionsの影響が残っている可能性"


def test_single_add_sections_object_types(worker):
    """add_sections 1回実行後のオブジェクト型を調査"""
    from collections import Counter

    gc.collect()
    before_types = Counter(type(obj).__name__ for obj in gc.get_objects())

    sections = [create_test_section(f"type-{i}", 0, f"Content {i} " * 50) for i in range(10)]
    worker.add_sections({"sections": sections})
    del sections
    gc.collect()

    after_types = Counter(type(obj).__name__ for obj in gc.get_objects())

    # 増加した型のトップ20を表示
    print("\n=== add_sections 1回実行後に増加した型 (トップ20) ===")
    type_increases = {}
    for typename in set(before_types.keys()) | set(after_types.keys()):
        increase = after_types.get(typename, 0) - before_types.get(typename, 0)
        if increase > 0:
            type_increases[typename] = increase

    for typename, count in sorted(type_increases.items(), key=lambda x: x[1], reverse=True)[:20]:
        print(f"  {typename}: +{count}")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
