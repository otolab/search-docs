"""Read-only, conservative detection of repeated section trees."""
from collections import defaultdict

from lancedb_utils import connect_lancedb, read_table_with_retry

MAX_ROWS = 50000
MAX_BYTES = 64 * 1024 * 1024
MAX_RESULTS = 100
COLUMNS = ["id", "document_path", "document_hash", "parent_id", "heading", "depth", "content", "order", "start_line", "end_line", "section_number"]


def _diagnose_table(table, max_rows=MAX_ROWS, max_bytes=MAX_BYTES):
    version = table.version
    table.checkout(version)
    groups = defaultdict(list)
    rows_read = 0
    bytes_read = 0
    complete = True
    # Limit each delivered batch to one row; a single row can still exceed
    # max_bytes and storage/decompression can read more than is delivered.
    for batch in table.search().select(COLUMNS).limit(None).to_batches(batch_size=1):
        rows_read += batch.num_rows
        bytes_read += batch.nbytes
        if rows_read > max_rows or bytes_read > max_bytes:
            complete = False
            break
        for row in batch.to_pylist():
            groups[(row['document_path'], row['document_hash'])].append(row)
    # Partial groups must never be reported as complete trees.
    if not complete:
        return {"version": version, "complete": False, "rowsRead": rows_read,
                "bytesRead": bytes_read, "candidates": [], "ambiguous": 0, "omitted": 0}
    candidates = []
    ambiguous = 0
    for (path, digest), rows in groups.items():
        nodes = {r['id']: r for r in rows if r['id']}
        if not path or not digest or len(nodes) != len(rows):
            ambiguous += 1
            continue
        children = defaultdict(list)
        invalid = False
        for r in rows:
            parent = r['parent_id']
            if parent is not None and parent not in nodes:
                invalid = True
                break
            if any(r[x] is None for x in ('heading', 'depth', 'content', 'order', 'start_line', 'end_line', 'section_number')):
                invalid = True
                break
            children[parent].append(r['id'])
        if invalid or not children[None]:
            ambiguous += 1
            continue
        visited = set()
        def tree(node_id):
            if node_id in visited:
                raise ValueError('cycle or repeated node')
            visited.add(node_id)
            r = nodes[node_id]
            attrs = (r['heading'], r['depth'], r['content'], r['order'], r['start_line'], r['end_line'], tuple(r['section_number']))
            descendants = sorted((tree(child) for child in children[node_id]), key=repr)
            return attrs, tuple(descendants)
        try:
            roots = [(root, tree(root)) for root in children[None]]
            if len(visited) != len(nodes):
                raise ValueError('unreachable nodes')
        except (ValueError, RecursionError, TypeError):
            ambiguous += 1
            continue
        equivalents = defaultdict(list)
        for root, signature in roots:
            equivalents[signature].append(root)
        for root_ids in equivalents.values():
            if len(root_ids) > 1:
                candidates.append({"path": path, "rootIds": sorted(root_ids)[:10],
                                   "rootCount": len(root_ids)})
    candidates.sort(key=lambda item: (item['path'], item['rootIds']))
    return {"version": version, "complete": True, "rowsRead": rows_read, "bytesRead": bytes_read,
            "candidates": candidates[:MAX_RESULTS], "ambiguous": ambiguous,
            "omitted": max(0, len(candidates) - MAX_RESULTS)}


def diagnose(db, max_rows=MAX_ROWS, max_bytes=MAX_BYTES):
    return read_table_with_retry(
        db, "sections", lambda table: _diagnose_table(table, max_rows, max_bytes)
    )


if __name__ == '__main__':
    import json
    import sys

    if len(sys.argv) != 2:
        raise SystemExit('usage: duplicate_diagnostics.py DB_PATH')
    print(json.dumps(diagnose(connect_lancedb(sys.argv[1])), ensure_ascii=False))
