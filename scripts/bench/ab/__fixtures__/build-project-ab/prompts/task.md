`logstat` is a small Go CLI that summarizes access logs. Please make these changes:

1. **JSON output.** Add a `--format` flag: `text` (the default — today's report, unchanged apart from item 2) or `json`. Any other value prints an error to stderr and exits with status 2. The JSON report is one object with exactly these keys:

   ```json
   {
     "requests": 20,
     "malformed": 1,
     "bytes": 51200,
     "status": {"2xx": 15, "3xx": 0, "4xx": 3, "5xx": 2},
     "latency_ms": {"p50": 120, "p95": 900, "p99": 1500},
     "top_paths": [{"path": "/api/users", "count": 12}]
   }
   ```

   All four status classes are always present, latencies are whole milliseconds, and `top_paths` has the same order and `--top` limit as the text report.

2. **p99.** Report a p99 latency next to p50 and p95 — in the text report as a `p99` row right after `p95`, formatted like the other two.

3. **Method filter.** Add `--method <verb>`: keep only the requests with that method, case-insensitively (`--method post` keeps `POST`). It combines with `--status` and `--since`.

4. **Bug.** Our production gateway writes slow requests in seconds (`1.5s`, `2s`), and logstat counts those lines as malformed, so the slowest requests drop out of the percentiles. Latencies like `850ms`, `1.5s` and `2s` must all parse.

Cover the changes with tests and update the README. When you're done, build the binary with `make build`, and make sure `go vet ./...` and `go test ./...` pass.
