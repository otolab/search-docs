---
"@search-docs/db-engine": patch
"@search-docs/server": patch
"@search-docs/mcp-server": patch
"@search-docs/cli": patch
---

Keep every LanceDB connection in sync with the latest table version (5s read consistency interval) and retry once after reopening the table when a read hits a file removed by cleanup, so non-writer processes no longer fail with `lance error: Not found` (#173).
