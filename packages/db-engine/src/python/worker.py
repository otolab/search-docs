#!/usr/bin/env python3
"""
search-docs LanceDB JSON-RPC Worker
標準入出力を介してTypeScriptと通信するPythonワーカー
"""

import sys
import json
import traceback
from typing import Any, Dict, Optional, List
from datetime import datetime
import lancedb
import pyarrow as pa
import pandas as pd
from pathlib import Path

# 埋め込みモデルをインポート
from embedding import create_embedding_model
# スキーマ定義をインポート
from schemas import (
    get_sections_schema,
    SECTIONS_TABLE,
    validate_section
)


class SearchDocsWorker:
    def __init__(self, db_path: str = "./.search-docs/index"):
        """search-docs LanceDBワーカーの初期化"""
        Path(db_path).mkdir(parents=True, exist_ok=True)
        self.db = lancedb.connect(db_path)

        # モデルを初期化（まだロードしない）
        model_name = self._get_model_name()
        self.embedding_model = create_embedding_model(model_name)
        self.vector_dimension = self.embedding_model.dimension if hasattr(self.embedding_model, 'dimension') else 256
        self.init_tables()

    def _get_model_name(self):
        """モデル名を取得

        Returns:
            モデル名
        """
        # コマンドライン引数からモデル名を取得（--model=xxx形式）
        model_name = None
        for arg in sys.argv[1:]:
            if arg.startswith('--model='):
                model_name = arg.split('=', 1)[1]
                break

        # デフォルトモデル名
        if not model_name:
            model_name = 'cl-nagoya/ruri-v3-30m'

        return model_name

    def init_tables(self):
        """必要なテーブルを初期化"""
        try:
            existing_tables = self.db.table_names()

            # Sections テーブル
            if SECTIONS_TABLE not in existing_tables:
                try:
                    self.db.create_table(SECTIONS_TABLE, schema=get_sections_schema(self.vector_dimension))
                except ValueError as e:
                    if "already exists" not in str(e):
                        raise
                    sys.stderr.write(f"Warning: Table {SECTIONS_TABLE} already exists, skipping creation\n")
                    sys.stderr.flush()

        except Exception as e:
            sys.stderr.write(f"Error initializing tables: {str(e)}\n")
            sys.stderr.write(f"Traceback: {traceback.format_exc()}\n")
            sys.stderr.flush()
            raise

    def format_section(self, section: Dict[str, Any]) -> Dict[str, Any]:
        """LanceDBのセクションデータをJSON-serializable形式に変換

        Args:
            section: LanceDBから取得した生のセクションデータ

        Returns:
            JSON-serializable形式のセクションデータ（camelCase）
        """
        # datetimeをISO文字列に変換
        created_at = section.get("created_at")
        updated_at = section.get("updated_at")

        return {
            "id": section["id"],
            "documentPath": section["document_path"],
            "heading": section["heading"],
            "depth": section["depth"],
            "content": section["content"],
            "tokenCount": section["token_count"],
            "parentId": section.get("parent_id"),
            "order": section["order"],
            "isDirty": section["is_dirty"],
            "documentHash": section["document_hash"],
            "createdAt": created_at.isoformat() if isinstance(created_at, datetime) else created_at,
            "updatedAt": updated_at.isoformat() if isinstance(updated_at, datetime) else updated_at,
            "summary": section.get("summary"),
            "documentSummary": section.get("document_summary"),
        }

    def handle_request(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """JSON-RPCリクエストを処理"""
        method = request.get("method")
        params = request.get("params", {})
        request_id = request.get("id")

        try:
            if method == "ping":
                result = self.ping()
            elif method == "initModel":
                result = self.init_model()
            elif method == "addSection":
                result = self.add_section(params)
            elif method == "addSections":
                result = self.add_sections(params)
            elif method == "search":
                result = self.search(params)
            elif method == "getSectionsByPath":
                result = self.get_sections_by_path(params)
            elif method == "deleteSectionsByPath":
                result = self.delete_sections_by_path(params)
            elif method == "markDirty":
                result = self.mark_dirty(params)
            elif method == "getDirtySections":
                result = self.get_dirty_sections(params)
            elif method == "getStats":
                result = self.get_stats()
            else:
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {
                        "code": -32601,
                        "message": f"Method not found: {method}"
                    }
                }

            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": result
            }

        except Exception as e:
            error_message = str(e)
            error_trace = traceback.format_exc()
            sys.stderr.write(f"Error in {method}: {error_message}\n")
            sys.stderr.write(f"Traceback: {error_trace}\n")
            sys.stderr.flush()

            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32603,
                    "message": error_message,
                    "data": error_trace
                }
            }

    def ping(self) -> Dict[str, str]:
        """接続確認"""
        return {"status": "ok"}

    def init_model(self) -> Dict[str, Any]:
        """埋め込みモデルを初期化"""
        success = self.embedding_model.initialize()
        return {
            "success": success,
            "model_name": self.embedding_model.model_name if hasattr(self.embedding_model, 'model_name') else 'unknown',
            "dimension": self.vector_dimension
        }

    def add_section(self, params: Dict[str, Any]) -> Dict[str, str]:
        """セクションを追加"""
        section = params.get("section")
        if not section:
            raise ValueError("section parameter is required")

        # バリデーション
        validate_section(section)

        # ベクトル化が必要な場合
        if "vector" not in section or not section["vector"]:
            text = f"{section['heading']}\n{section['content']}"
            if not self.embedding_model.is_loaded:
                self.embedding_model.initialize()
            section["vector"] = self.embedding_model.encode(text, self.vector_dimension)

        # タイムスタンプをPandas Timestampに変換
        section["created_at"] = pd.Timestamp(section["created_at"]).floor('ms')
        section["updated_at"] = pd.Timestamp(section["updated_at"]).floor('ms')

        # テーブルに追加
        table = self.db.open_table(SECTIONS_TABLE)
        table.add([section])

        return {"id": section["id"]}

    def add_sections(self, params: Dict[str, Any]) -> Dict[str, int]:
        """複数のセクションを追加"""
        sections = params.get("sections")
        if not sections:
            raise ValueError("sections parameter is required")

        # モデル初期化
        if not self.embedding_model.is_loaded:
            self.embedding_model.initialize()

        # 各セクションを処理
        for section in sections:
            validate_section(section)

            # ベクトル化
            if "vector" not in section or not section["vector"]:
                text = f"{section['heading']}\n{section['content']}"
                section["vector"] = self.embedding_model.encode(text, self.vector_dimension)

            # タイムスタンプ変換
            section["created_at"] = pd.Timestamp(section["created_at"]).floor('ms')
            section["updated_at"] = pd.Timestamp(section["updated_at"]).floor('ms')

        # 一括追加
        table = self.db.open_table(SECTIONS_TABLE)
        table.add(sections)

        return {"count": len(sections)}

    def search(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """セクションを検索"""
        query = params.get("query")
        limit = params.get("limit", 10)
        depth = params.get("depth")
        include_clean_only = params.get("includeCleanOnly", False)

        if not query:
            raise ValueError("query parameter is required")

        # モデル初期化
        if not self.embedding_model.is_loaded:
            self.embedding_model.initialize()

        # クエリをベクトル化
        query_vector = self.embedding_model.encode(query, self.vector_dimension)

        # 検索
        table = self.db.open_table(SECTIONS_TABLE)
        search_query = table.search(query_vector).limit(limit)

        # フィルタ適用
        filters = []
        if depth is not None:
            if isinstance(depth, list):
                depth_conditions = " OR ".join([f"depth = {d}" for d in depth])
                filters.append(f"({depth_conditions})")
            else:
                filters.append(f"depth = {depth}")

        if include_clean_only:
            filters.append("is_dirty = false")

        if filters:
            search_query = search_query.where(" AND ".join(filters))

        results = search_query.to_list()

        # 結果を整形
        formatted_results = []
        for result in results:
            formatted_results.append({
                "id": result["id"],
                "documentPath": result["document_path"],
                "heading": result["heading"],
                "depth": result["depth"],
                "content": result["content"],
                "score": float(result.get("_distance", 0)),
                "isDirty": result["is_dirty"],
                "tokenCount": result["token_count"]
            })

        return {
            "results": formatted_results,
            "total": len(formatted_results)
        }

    def get_sections_by_path(self, params: Dict[str, Any]) -> Dict[str, List]:
        """指定パスのセクションを取得"""
        document_path = params.get("documentPath")
        if not document_path:
            raise ValueError("documentPath parameter is required")

        table = self.db.open_table(SECTIONS_TABLE)
        results = table.search().where(f"document_path = '{document_path}'").to_list()

        # 結果をフォーマット
        formatted_sections = [self.format_section(section) for section in results]

        return {"sections": formatted_sections}

    def delete_sections_by_path(self, params: Dict[str, Any]) -> Dict[str, int]:
        """指定パスのセクションを削除"""
        document_path = params.get("documentPath")
        if not document_path:
            raise ValueError("documentPath parameter is required")

        table = self.db.open_table(SECTIONS_TABLE)
        table.delete(f"document_path = '{document_path}'")

        return {"deleted": True}

    def mark_dirty(self, params: Dict[str, Any]) -> Dict[str, int]:
        """指定パスのセクションをDirtyにマーク"""
        document_path = params.get("documentPath")
        if not document_path:
            raise ValueError("documentPath parameter is required")

        table = self.db.open_table(SECTIONS_TABLE)
        # LanceDBの更新操作
        table.update(
            where=f"document_path = '{document_path}'",
            values={"is_dirty": True}
        )

        return {"marked": True}

    def get_dirty_sections(self, params: Dict[str, Any]) -> Dict[str, List]:
        """Dirtyなセクションを取得"""
        limit = params.get("limit", 100)

        table = self.db.open_table(SECTIONS_TABLE)
        results = table.search()\
            .where("is_dirty = true")\
            .limit(limit)\
            .to_list()

        # 結果をフォーマット
        formatted_sections = [self.format_section(section) for section in results]

        return {"sections": formatted_sections}

    def get_stats(self) -> Dict[str, Any]:
        """統計情報を取得"""
        table = self.db.open_table(SECTIONS_TABLE)

        # 全件数
        total = table.count_rows()

        # Dirty件数
        dirty_results = table.search().where("is_dirty = true").to_list()
        dirty_count = len(dirty_results)

        # ユニークな文書数
        all_sections = table.search().to_list()
        unique_paths = set(s["document_path"] for s in all_sections)

        return {
            "totalSections": total,
            "dirtyCount": dirty_count,
            "totalDocuments": len(unique_paths)
        }


def main():
    """メインループ"""
    worker = SearchDocsWorker()

    # 標準入力からJSON-RPCリクエストを読み取る
    for line in sys.stdin:
        try:
            request = json.loads(line)
            response = worker.handle_request(request)
            print(json.dumps(response), flush=True)
        except json.JSONDecodeError as e:
            sys.stderr.write(f"Invalid JSON: {e}\n")
            sys.stderr.flush()
        except Exception as e:
            sys.stderr.write(f"Error: {e}\n")
            sys.stderr.write(f"Traceback: {traceback.format_exc()}\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()
