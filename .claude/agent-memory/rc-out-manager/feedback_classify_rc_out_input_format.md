---
name: feedback-classify-rc-out-input-format
description: classify_rc_out.py expects db_rows_json as [{"data": [...]}] array-of-one-object, not {"data": [...]} dict
metadata:
  type: feedback
---

The Supabase MCP `execute_sql` returns `json_agg(...)` results as a single JSON object `{"data": [...]}`. But `classify_rc_out.py` expects the db_rows file to be in the format `[{"data": [...]}]` — an array containing one object with a "data" key. The classifier has an unwrap guard at line 158 that handles this specific shape.

**Rule:** When writing `rc_out_rows.json` from Supabase MCP results, wrap the rows as `[{"data": rows}]`, not `{"data": rows}`.

**Why:** Discovered 2026-05-27 during first end-to-end PROPOSE run. The classifier threw `AttributeError: 'str' object has no attribute 'get'` when given the raw dict format. Writing as `[{"data": rows}]` matches the unwrap logic at classify_rc_out.py lines 158–159.

**How to apply:** After collecting DB rows from Supabase MCP, write the JSON file as:
```python
json.dump([{"data": rows}], f)
```
Not:
```python
json.dump({"data": rows}, f)
```

**Related:** [[feedback-reconciliation-scope]]
