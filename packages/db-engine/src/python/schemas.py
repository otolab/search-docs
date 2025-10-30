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


def get_index_requests_schema() -> pa.Schema:
    """IndexRequestsテーブルのスキーマを返す

    Returns:
        IndexRequestsテーブルのスキーマ
    """
    return pa.schema([
        pa.field("id", pa.string()),
        pa.field("document_path", pa.string()),
        pa.field("document_hash", pa.string()),
        pa.field("status", pa.string()),  # 'pending', 'processing', 'completed', 'failed', 'skipped'
        pa.field("created_at", pa.timestamp('ms')),
        pa.field("started_at", pa.timestamp('ms')),
        pa.field("completed_at", pa.timestamp('ms')),
        pa.field("error", pa.string()),
    ])


# テーブル名の定義
SECTIONS_TABLE = "sections"
INDEX_REQUESTS_TABLE = "index_requests"

# 全テーブルのリスト
ALL_TABLES = [SECTIONS_TABLE, INDEX_REQUESTS_TABLE]


def validate_section(section_data: dict) -> None:
    """Sectionデータのバリデーション

    Args:
        section_data: 検証するSectionデータ

    Raises:
        ValueError: 必須フィールドが不足している場合
        TypeError: フィールドの型が不正な場合
    """
    # 必須フィールドの検証
    # Note: vectorはPython側で生成されるため、受信時には不要
    required_fields = [
        'id', 'document_path', 'heading', 'depth', 'content',
        'token_count', 'order', 'is_dirty', 'document_hash'
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


def validate_index_request(request_data: dict, for_creation: bool = False) -> None:
    """IndexRequestデータのバリデーション

    Args:
        request_data: 検証するIndexRequestデータ
        for_creation: 作成時のバリデーションかどうか（True: id/statusは不要）

    Raises:
        ValueError: 必須フィールドが不足している場合
        TypeError: フィールドの型が不正な場合
    """
    # 作成時は document_path と document_hash のみ必須
    # 更新時・検証時は id と status も含む
    if for_creation:
        required_fields = ['document_path', 'document_hash']
    else:
        required_fields = ['id', 'document_path', 'document_hash', 'status']

    missing_fields = [field for field in required_fields if field not in request_data]

    if missing_fields:
        raise ValueError(f"Missing required fields: {', '.join(missing_fields)}")

    # フィールドの型検証
    if not isinstance(request_data.get('document_path'), str):
        raise TypeError("Field 'document_path' must be a string")
    if not isinstance(request_data.get('document_hash'), str):
        raise TypeError("Field 'document_hash' must be a string")

    # status検証（存在する場合のみ）
    if 'status' in request_data:
        if not isinstance(request_data.get('status'), str):
            raise TypeError("Field 'status' must be a string")

        # status値の検証
        valid_statuses = ['pending', 'processing', 'completed', 'failed', 'skipped']
        if request_data.get('status') not in valid_statuses:
            raise ValueError(f"Field 'status' must be one of: {', '.join(valid_statuses)}")
