package report

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"example.com/logstat/internal/stats"
)

func summary() stats.Summary {
	return stats.Summary{
		Requests: 3,
		Bytes:    300,
		ByClass:  map[string]int{"2xx": 2, "5xx": 1},
		P50:      40 * time.Millisecond,
		P95:      1500 * time.Millisecond,
		P99:      2 * time.Second,
		TopPaths: []stats.PathCount{{Path: "/a", Count: 2}, {Path: "/b", Count: 1}},
	}
}

func TestText(t *testing.T) {
	var b strings.Builder
	if err := Text(&b, summary(), 1); err != nil {
		t.Fatal(err)
	}
	want := `requests   3
malformed  1
bytes      300
2xx        2
3xx        0
4xx        0
5xx        1
p50        40ms
p95        1.5s
p99        2s
top paths
     2  /a
     1  /b
`
	if got := b.String(); got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestJSON(t *testing.T) {
	var b strings.Builder
	if err := JSON(&b, summary(), 1); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(b.String()), &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"requests":   3.0,
		"malformed":  1.0,
		"bytes":      300.0,
		"status":     map[string]any{"2xx": 2.0, "3xx": 0.0, "4xx": 0.0, "5xx": 1.0},
		"latency_ms": map[string]any{"p50": 40.0, "p95": 1500.0, "p99": 2000.0},
		"top_paths": []any{
			map[string]any{"path": "/a", "count": 2.0},
			map[string]any{"path": "/b", "count": 1.0},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v\nwant %v", got, want)
	}
}
