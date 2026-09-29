package stats

import (
	"testing"
	"time"

	"example.com/logstat/internal/logparse"
)

func ms(n int) time.Duration { return time.Duration(n) * time.Millisecond }

func TestPercentile(t *testing.T) {
	sorted := []time.Duration{ms(10), ms(20), ms(30), ms(40), ms(50), ms(60), ms(70), ms(80), ms(90), ms(100)}
	for _, c := range []struct {
		p    float64
		want time.Duration
	}{
		{1, ms(10)},
		{50, ms(50)},
		{95, ms(100)},
		{100, ms(100)},
	} {
		if got := Percentile(sorted, c.p); got != c.want {
			t.Errorf("Percentile(p%v) = %v, want %v", c.p, got, c.want)
		}
	}
	if got := Percentile(nil, 50); got != 0 {
		t.Errorf("Percentile of nothing = %v, want 0", got)
	}
}

func TestSummarize(t *testing.T) {
	entry := func(path string, status, latency int) logparse.Entry {
		return logparse.Entry{Path: path, Status: status, Latency: ms(latency), Bytes: 100}
	}
	s := Summarize([]logparse.Entry{
		entry("/b", 200, 30),
		entry("/a", 200, 10),
		entry("/a", 404, 20),
		entry("/b", 500, 40),
		entry("/c", 301, 50),
	}, 2)
	if s.Requests != 5 || s.Bytes != 500 {
		t.Errorf("requests %d bytes %d, want 5 and 500", s.Requests, s.Bytes)
	}
	for class, want := range map[string]int{"2xx": 2, "3xx": 1, "4xx": 1, "5xx": 1} {
		if s.ByClass[class] != want {
			t.Errorf("%s = %d, want %d", class, s.ByClass[class], want)
		}
	}
	if s.P50 != ms(30) || s.P95 != ms(50) {
		t.Errorf("p50 %v p95 %v, want 30ms and 50ms", s.P50, s.P95)
	}
	// Ties are broken by path, and the list stops at top.
	want := []PathCount{{Path: "/a", Count: 2}, {Path: "/b", Count: 2}}
	if len(s.TopPaths) != len(want) || s.TopPaths[0] != want[0] || s.TopPaths[1] != want[1] {
		t.Errorf("top paths %v, want %v", s.TopPaths, want)
	}
}
