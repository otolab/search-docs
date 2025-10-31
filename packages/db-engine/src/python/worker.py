#!/usr/bin/env python3
"""
search-docs LanceDB JSON-RPC Worker
標準入出力を介してTypeScriptと通信するPythonワーカー
"""

import sys
import io
import json
import traceback
import uuid
from typing import Any, Dict, Optional, List
from datetime import datetime
import lancedb
import pyarrow as pa
import pandas as pd
import numpy as np
from pathlib import Path

# 埋め込みモデルをインポート
from embedding import create_embedding_model
# スキーマ定義をインポート
from schemas import (
    get_sections_schema,
    get_index_requests_schema,
    SECTIONS_TABLE,
    INDEX_REQUESTS_TABLE,
    validate_section,
    validate_index_request
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

    @staticmethod
    def _get_db_path() -> str:
        """コマンドライン引数からdb_pathを取得

        Returns:
            db_path文字列
        """
        for arg in sys.argv[1:]:
            if arg.startswith('--db-path='):
                return arg.split('=', 1)[1]
        # デフォルト値
        return "./.search-docs/index"

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

            # IndexRequests テーブル
            if INDEX_REQUESTS_TABLE not in existing_tables:
                try:
                    self.db.create_table(INDEX_REQUESTS_TABLE, schema=get_index_requests_schema())
                except ValueError as e:
                    if "already exists" not in str(e):
                        raise
                    sys.stderr.write(f"Warning: Table {INDEX_REQUESTS_TABLE} already exists, skipping creation\n")
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
            "startLine": section.get("start_line"),
            "endLine": section.get("end_line"),
            "sectionNumber": section.get("section_number"),
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
            elif method == "addSections":
                result = self.add_sections(params)
            elif method == "search":
                result = self.search(params)
            elif method == "getSectionsByPath":
                result = self.get_sections_by_path(params)
            elif method == "getSectionById":
                result = self.get_section_by_id(params)
            elif method == "deleteSectionsByPath":
                result = self.delete_sections_by_path(params)
            elif method == "findSectionsByPathAndHash":
                result = self.find_sections_by_path_and_hash(params)
            elif method == "deleteSectionsByPathExceptHash":
                result = self.delete_sections_by_path_except_hash(params)
            elif method == "markDirty":
                result = self.mark_dirty(params)
            elif method == "getDirtySections":
                result = self.get_dirty_sections(params)
            elif method == "getStats":
                result = self.get_stats()
            # IndexRequest操作
            elif method == "createIndexRequest":
                result = self.create_index_request(params)
            elif method == "findIndexRequests":
                result = self.find_index_requests(params)
            elif method == "updateIndexRequest":
                result = self.update_index_request(params)
            elif method == "updateManyIndexRequests":
                result = self.update_many_index_requests(params)
            elif method == "getPathsWithStatus":
                result = self.get_paths_with_status(params)
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

    def _normalize_section_data(self, section: Dict[str, Any]) -> None:
        """セクションデータの正規化（in-place）"""
        # タイムスタンプをPandas Timestampに変換
        section["created_at"] = pd.Timestamp(section["created_at"]).floor('ms')
        section["updated_at"] = pd.Timestamp(section["updated_at"]).floor('ms')

        # Task 14: 行番号フィールドをnp.int32に変換
        if "start_line" in section and section["start_line"] is not None:
            section["start_line"] = np.int32(section["start_line"])
        if "end_line" in section and section["end_line"] is not None:
            section["end_line"] = np.int32(section["end_line"])

        # section_numberを明示的にnp.int32に変換（JavaScriptのnumberはPython int64として扱われるため）
        if "section_number" in section and section["section_number"] is not None:
            # np.int32のままにする（PyArrowがint32として認識できるように）
            section["section_number"] = [np.int32(n) for n in section["section_number"]]

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

            # データ正規化
            self._normalize_section_data(section)

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
        exclude_paths = params.get("excludePaths", [])

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

        if exclude_paths:
            # パス除外フィルタ（NOT IN形式）
            # LanceDBのSQL構文でNOT INを使用
            escaped_paths = [f"'{path}'" for path in exclude_paths]
            filters.append(f"document_path NOT IN ({', '.join(escaped_paths)})")

        if filters:
            search_query = search_query.where(" AND ".join(filters))

        results = search_query.to_list()

        # 結果を整形
        formatted_results = []
        for result in results:
            formatted_results.append({
                "id": result["id"],
                "documentPath": result["document_path"],
                "documentHash": result["document_hash"],
                "heading": result["heading"],
                "depth": result["depth"],
                "content": result["content"],
                "score": float(result.get("_distance", 0)),
                "isDirty": result["is_dirty"],
                "tokenCount": result["token_count"],
                # Task 14 Phase 2: 新しいフィールドを追加
                "startLine": result.get("start_line"),
                "endLine": result.get("end_line"),
                "sectionNumber": result.get("section_number"),
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

    def get_section_by_id(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """IDでセクションを取得"""
        section_id = params.get("sectionId")
        if not section_id:
            raise ValueError("sectionId parameter is required")

        table = self.db.open_table(SECTIONS_TABLE)
        results = table.search().where(f"id = '{section_id}'").to_list()

        if not results:
            raise ValueError(f"Section not found: {section_id}")

        return {"section": self.format_section(results[0])}

    def delete_sections_by_path(self, params: Dict[str, Any]) -> Dict[str, int]:
        """指定パスのセクションを削除"""
        document_path = params.get("documentPath")
        if not document_path:
            raise ValueError("documentPath parameter is required")

        table = self.db.open_table(SECTIONS_TABLE)
        table.delete(f"document_path = '{document_path}'")

        return {"deleted": True}

    def find_sections_by_path_and_hash(self, params: Dict[str, Any]) -> Dict[str, List]:
        """特定のdocument_pathとdocument_hashのセクションを取得"""
        document_path = params.get("documentPath")
        document_hash = params.get("documentHash")

        if not document_path:
            raise ValueError("documentPath parameter is required")
        if not document_hash:
            raise ValueError("documentHash parameter is required")

        table = self.db.open_table(SECTIONS_TABLE)
        results = table.search()\
            .where(f"document_path = '{document_path}' AND document_hash = '{document_hash}'")\
            .to_list()

        # 結果をフォーマット
        formatted_sections = [self.format_section(section) for section in results]

        return {"sections": formatted_sections}

    def delete_sections_by_path_except_hash(self, params: Dict[str, Any]) -> Dict[str, int]:
        """指定パスのセクションのうち、指定したhash以外を削除"""
        document_path = params.get("documentPath")
        document_hash = params.get("documentHash")

        if not document_path:
            raise ValueError("documentPath parameter is required")
        if not document_hash:
            raise ValueError("documentHash parameter is required")

        table = self.db.open_table(SECTIONS_TABLE)

        # 指定したhash以外を削除
        table.delete(f"document_path = '{document_path}' AND document_hash != '{document_hash}'")

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

    # ========================================
    # IndexRequest操作
    # ========================================

    def create_index_request(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """IndexRequestを作成"""
        # バリデーション（作成時用）
        validate_index_request(params, for_creation=True)

        table = self.db.open_table(INDEX_REQUESTS_TABLE)

        # IDを生成
        request_id = str(uuid.uuid4())

        # タイムスタンプをPyArrow形式に変換（ミリ秒精度）
        now = pd.Timestamp.now(tz='UTC').floor('ms')
        request_data = {
            "id": request_id,
            "document_path": params["document_path"],
            "document_hash": params["document_hash"],
            "status": "pending",  # 作成時は常にpending
            "created_at": now,
            "started_at": None,
            "completed_at": None,
            "error": None,
        }

        # データを追加
        table.add([request_data])

        # 完全なリクエストオブジェクトを返す（camelCaseに変換）
        return {
            "id": request_data["id"],
            "documentPath": request_data["document_path"],
            "documentHash": request_data["document_hash"],
            "status": request_data["status"],
            "createdAt": request_data["created_at"].isoformat(),
            "startedAt": None,
            "completedAt": None,
            "error": None,
        }

    def find_index_requests(self, params: Dict[str, Any]) -> Dict[str, List]:
        """IndexRequestを検索"""
        table = self.db.open_table(INDEX_REQUESTS_TABLE)

        # フィルタ条件の構築
        where_clauses = []

        if "document_path" in params:
            where_clauses.append(f"document_path = '{params['document_path']}'")

        if "document_hash" in params:
            where_clauses.append(f"document_hash = '{params['document_hash']}'")

        if "status" in params:
            status = params["status"]
            if isinstance(status, list):
                # 複数のstatusをORで結合
                status_clauses = [f"status = '{s}'" for s in status]
                where_clauses.append(f"({' OR '.join(status_clauses)})")
            else:
                where_clauses.append(f"status = '{status}'")

        # クエリの実行
        query = table.search()

        if where_clauses:
            where_str = " AND ".join(where_clauses)
            query = query.where(where_str)

        # order指定
        order = params.get("order", "created_at ASC")
        results = query.to_list()

        # ソート
        if "DESC" in order:
            results = sorted(results, key=lambda x: x.get("created_at", pd.Timestamp.min), reverse=True)
        else:
            results = sorted(results, key=lambda x: x.get("created_at", pd.Timestamp.min))

        # 結果をフォーマット
        formatted_requests = []
        for req in results:
            formatted_req = {
                "id": req["id"],
                "documentPath": req["document_path"],
                "documentHash": req["document_hash"],
                "status": req["status"],
                "createdAt": req["created_at"].isoformat() if req.get("created_at") else None,
                "startedAt": req["started_at"].isoformat() if req.get("started_at") else None,
                "completedAt": req["completed_at"].isoformat() if req.get("completed_at") else None,
                "error": req.get("error"),
            }
            formatted_requests.append(formatted_req)

        return {"requests": formatted_requests}

    def update_index_request(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """IndexRequestを更新"""
        request_id = params.get("id")
        if not request_id:
            raise ValueError("Missing required field: id")

        updates = params.get("updates", {})
        if not updates:
            raise ValueError("Missing required field: updates")

        table = self.db.open_table(INDEX_REQUESTS_TABLE)

        # タイムスタンプの変換（ミリ秒精度）
        if "started_at" in updates and updates["started_at"]:
            updates["started_at"] = pd.Timestamp(updates["started_at"], tz='UTC').floor('ms')
        if "completed_at" in updates and updates["completed_at"]:
            updates["completed_at"] = pd.Timestamp(updates["completed_at"], tz='UTC').floor('ms')

        # 更新実行
        table.update(
            where=f"id = '{request_id}'",
            values=updates
        )

        # 更新後のオブジェクトを取得して返す
        df = table.search().where(f"id = '{request_id}'").limit(1).to_pandas()
        if len(df) == 0:
            raise ValueError(f"Request not found after update: {request_id}")

        req = df.iloc[0].to_dict()
        return {
            "id": req["id"],
            "documentPath": req["document_path"],
            "documentHash": req["document_hash"],
            "status": req["status"],
            "createdAt": req["created_at"].isoformat() if req.get("created_at") else None,
            "startedAt": req["started_at"].isoformat() if req.get("started_at") else None,
            "completedAt": req["completed_at"].isoformat() if req.get("completed_at") else None,
            "error": req.get("error"),
        }

    def update_many_index_requests(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """複数のIndexRequestを更新"""
        filter_params = params.get("filter", {})
        updates = params.get("updates", {})

        if not updates:
            raise ValueError("Missing required field: updates")

        table = self.db.open_table(INDEX_REQUESTS_TABLE)

        # フィルタ条件の構築
        where_clauses = []

        if "document_path" in filter_params:
            where_clauses.append(f"document_path = '{filter_params['document_path']}'")

        if "status" in filter_params:
            where_clauses.append(f"status = '{filter_params['status']}'")

        if "created_at" in filter_params:
            created_at = filter_params["created_at"]
            if "$lt" in created_at:
                timestamp = pd.Timestamp(created_at["$lt"])
                where_clauses.append(f"created_at < timestamp '{timestamp.isoformat()}'")
            if "$gt" in created_at:
                timestamp = pd.Timestamp(created_at["$gt"])
                where_clauses.append(f"created_at > timestamp '{timestamp.isoformat()}'")

        if not where_clauses:
            raise ValueError("Filter conditions are required for bulk update")

        # タイムスタンプの変換（ミリ秒精度）
        if "completed_at" in updates and updates["completed_at"]:
            updates["completed_at"] = pd.Timestamp(updates["completed_at"], tz='UTC').floor('ms')

        # 更新前の件数を取得
        where_str = " AND ".join(where_clauses)
        count_df = table.search().where(where_str).to_pandas()
        count = len(count_df)

        # 更新実行
        table.update(
            where=where_str,
            values=updates
        )

        return {"updated": True, "count": count}

    def get_paths_with_status(self, params: Dict[str, Any]) -> Dict[str, List]:
        """特定のstatusを持つdocument_pathを取得"""
        statuses = params.get("statuses", [])
        if not statuses:
            raise ValueError("Missing required field: statuses")

        table = self.db.open_table(INDEX_REQUESTS_TABLE)

        # statusフィルタの構築
        status_clauses = [f"status = '{s}'" for s in statuses]
        where_str = " OR ".join(status_clauses)

        # クエリ実行
        results = table.search().where(where_str).to_list()

        # ユニークなdocument_pathを抽出
        paths = list(set(r["document_path"] for r in results))

        return {"paths": paths}


def main():
    """メインループ"""
    # 標準入出力をUTF-8で明示的にラップ
    sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)

    db_path = SearchDocsWorker._get_db_path()
    worker = SearchDocsWorker(db_path=db_path)

    # 標準入力からJSON-RPCリクエストを読み取る
    for line in sys.stdin:
        try:
            request = json.loads(line)
            response = worker.handle_request(request)
            print(json.dumps(response, ensure_ascii=False), flush=True)
        except json.JSONDecodeError as e:
            sys.stderr.write(f"Invalid JSON: {e}\n")
            sys.stderr.flush()
        except Exception as e:
            sys.stderr.write(f"Error: {e}\n")
            sys.stderr.write(f"Traceback: {traceback.format_exc()}\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()
