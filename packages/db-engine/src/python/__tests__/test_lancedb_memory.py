"""
LanceDBのメモリ管理を詳細に調査
table.add()後にデータ参照が残っているかを確認
"""

import pytest
import gc
import sys
import tempfile
import shutil
from pathlib import Path
from datetime import datetime
import pandas as pd
import pyarrow as pa

sys.path.insert(0, str(Path(__file__).parent.parent))

import lancedb
from schemas import get_sections_schema, SECTIONS_TABLE


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
        "created_at": pd.Timestamp.now(tz='UTC').floor('ms'),
        "updated_at": pd.Timestamp.now(tz='UTC').floor('ms'),
        "vector": [0.1] * 256,  # ダミーベクトル
    }
    section.update(overrides)
    return section


@pytest.fixture
def temp_db():
    """一時的なDBディレクトリを作成"""
    temp_dir = tempfile.mkdtemp()
    yield temp_dir
    shutil.rmtree(temp_dir)


def get_object_count():
    """現在のオブジェクト数を取得"""
    gc.collect()
    return len(gc.get_objects())


def test_lancedb_add_without_explicit_delete(temp_db):
    """table.add()後に明示的削除なしの場合のオブジェクト数"""

    db = lancedb.connect(temp_db)
    db.create_table(SECTIONS_TABLE, schema=get_sections_schema(256))
    table = db.open_table(SECTIONS_TABLE)

    gc.collect()
    initial = get_object_count()
    print(f"\n初期オブジェクト数: {initial}")

    # データ追加（明示的削除なし）
    for i in range(10):
        sections = [create_test_section(f"no-del-{i}-{j}", i, f"Content {j} " * 50) for j in range(10)]
        table.add(sections)
        # del sections なし
        gc.collect()

    after = get_object_count()
    increase = after - initial
    print(f"10回追加後のオブジェクト数: {after}")
    print(f"増加数: {increase} ({increase / 10:.1f}/iteration)")


def test_lancedb_add_with_explicit_delete(temp_db):
    """table.add()後に明示的削除ありの場合のオブジェクト数"""

    db = lancedb.connect(temp_db)
    db.create_table(SECTIONS_TABLE, schema=get_sections_schema(256))
    table = db.open_table(SECTIONS_TABLE)

    gc.collect()
    initial = get_object_count()
    print(f"\n初期オブジェクト数: {initial}")

    # データ追加（明示的削除あり）
    for i in range(10):
        sections = [create_test_section(f"with-del-{i}-{j}", i, f"Content {j} " * 50) for j in range(10)]
        table.add(sections)
        del sections  # 明示的削除
        gc.collect()

    after = get_object_count()
    increase = after - initial
    print(f"10回追加後のオブジェクト数: {after}")
    print(f"増加数: {increase} ({increase / 10:.1f}/iteration)")


def test_lancedb_add_object_references(temp_db):
    """table.add()がデータのコピーを保持するか、参照を保持するかを確認"""

    db = lancedb.connect(temp_db)
    db.create_table(SECTIONS_TABLE, schema=get_sections_schema(256))
    table = db.open_table(SECTIONS_TABLE)

    gc.collect()

    # sectionsを作成し、そのIDを記録
    sections = [create_test_section(f"ref-test-{i}", 0, f"Content {i} " * 50) for i in range(10)]
    sections_ids = [id(s) for s in sections]

    print(f"\nadd()前のsections ID: {sections_ids[:3]}...")

    # add実行
    table.add(sections)

    print(f"add()後のsections ID: {[id(s) for s in sections][:3]}...")

    # sectionsを削除
    del sections
    gc.collect()

    # gc.get_objects()からsections_idsのいずれかが残っているか確認
    remaining_ids = {id(obj) for obj in gc.get_objects()}
    still_alive = [sid for sid in sections_ids if sid in remaining_ids]

    print(f"\nadd()とdel後に残っているsection dict: {len(still_alive)}/{len(sections_ids)}")

    if still_alive:
        print("⚠️  LanceDBが元のdictへの参照を保持している可能性あり")
    else:
        print("✅ 全てのsection dictが解放された")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
