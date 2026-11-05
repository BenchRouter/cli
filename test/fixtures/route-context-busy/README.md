These HTTP 409 `route_context_busy` bodies follow the contract agreed with the server
owner on 2026-11-04: `error.open_result_set_id` (string), `error.pr_number` (integer, or
null for a production result set) and `error.expected_close_at` (ISO-8601 UTC, or null
when unknown). The `message` text is a placeholder; the CLI prints whatever the server sends.

The server change that adds these fields was not live when these files were written, so
no live response could be captured. Replace both files with captured responses once
the change is live on api.benchrouter.com.
