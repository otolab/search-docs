---
"@search-docs/db-engine": patch
---

fix: LanceDB optimize の cleanup_older_than を 0 → 10分に変更し、マルチプロセス環境でのインデックス破損を防止
