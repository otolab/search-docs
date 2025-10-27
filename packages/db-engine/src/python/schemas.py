#!/usr/bin/env python3
"""
search-docs用のLanceDBスキーマ定義
"""

import pyarrow as pa


def get_sections_schema(vector_dimension: int = 256) -> pa.Schema:
    """Sectionsテーブルのスキーマを返す

    Args:
        vector_dimension: ベクトルの次元数（デフォルト: 256）

    Returns:
        Sectionsテーブルのスキーマ
    """
    return pa.schema([
        pa.field("id", pa.string()),
        pa.field("document_path", pa.string()),
        pa.field("heading", pa.string()),
        pa.field("depth", pa.int32()),
        pa.field("content", pa.string()),
        pa.field("token_count", pa.int32()),
        pa.field("vector", pa.list_(pa.float32(), vector_dimension)),
        pa.field("parent_id", pa.string()),
        pa.field("order", pa.int32()),
        pa.field("is_dirty", pa.bool_()),
        pa.field("document_hash", pa.string()),
        pa.field("created_at", pa.timestamp('ms')),
        pa.field("updated_at", pa.timestamp('ms'))
    ])


# テーブル名の定義
SECTIONS_TABLE = "sections"

# 全テーブルのリスト
ALL_TABLES = [SECTIONS_TABLE]


def validate_section(section_data: dict) -> None:
    """Sectionデータのバリデーション

    Args:
        section_data: 検証するSectionデータ

    Raises:
        ValueError: 必須フィールドが不足している場合
        TypeError: フィールドの型が不正な場合
    """
    # 必須フィールドの検証
    required_fields = [
        'id', 'document_path', 'heading', 'depth', 'content',
        'token_count', 'vector', 'order', 'is_dirty', 'document_hash'
    ]
    missing_fields = [field for field in required_fields if field not in section_data]

    if missing_fields:
        raise ValueError(f"Missing required fields: {', '.join(missing_fields)}")

    # フィールドの型検証
    if not isinstance(section_data.get('document_path'), str):
        raise TypeError("Field 'document_path' must be a string")
    if not isinstance(section_data.get('heading'), str):
        raise TypeError("Field 'heading' must be a string")
    if not isinstance(section_data.get('depth'), int):
        raise TypeError("Field 'depth' must be an integer")
    if section_data.get('depth') < 0 or section_data.get('depth') > 3:
        raise ValueError("Field 'depth' must be between 0 and 3")
    if not isinstance(section_data.get('is_dirty'), bool):
        raise TypeError("Field 'is_dirty' must be a boolean")
