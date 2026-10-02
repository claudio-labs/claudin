# logstat

Summarizes an access log: requests per status class, latency percentiles and
the busiest paths.

## Log format

One request per line, six space-separated fields:

    2026-09-01T10:00:05Z GET /api/users 200 45ms 2048

timestamp (RFC 3339), method, path, status, latency, response bytes. Blank
lines and lines starting with `#` are skipped; any other line that does not
parse is counted as malformed and left out of the numbers.

## Usage

    logstat [flags] <access.log>

Flags go before the file.

| flag | meaning |
|---|---|
| `--top N` | paths in the busiest-paths list (default 5) |
| `--status C` | keep one status class: `2xx`, `3xx`, `4xx` or `5xx` |
| `--since T` | keep requests at or after an RFC 3339 time |

Percentiles are nearest-rank.

    $ bin/logstat testdata/access.log
    requests   12
    malformed  0
    bytes      11824
    2xx        9
    3xx        1
    4xx        1
    5xx        1
    p50        47ms
    p95        640ms
    top paths
         4  /api/users
         3  /api/orders
         2  /api/users/17
         2  /health
         1  /login

## Development

    make build   # bin/logstat
    make test    # go test ./...
    make vet     # go vet ./...
