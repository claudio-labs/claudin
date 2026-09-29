package report

import (
	"strings"
	"testing"
	"time"

	"example.com/logstat/internal/stats"
)

func TestText(t *testing.T) {
	s := stats.Summary{
		Requests: 3,
		Bytes:    300,
		ByClass:  map[string]int{"2xx": 2, "5xx": 1},
		P50:      40 * time.Millisecond,
		P95:      1500 * time.Millisecond,
		TopPaths: []stats.PathCount{{Path: "/a", Count: 2}, {Path: "/b", Count: 1}},
	}
	var b strings.Builder
	if err := Text(&b, s, 1); err != nil {
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
busiest paths
     2  /a
     1  /b
`
	if got := b.String(); got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}
