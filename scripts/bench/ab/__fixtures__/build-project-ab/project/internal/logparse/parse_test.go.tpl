package logparse

import (
	"strings"
	"testing"
	"time"
)

func TestParseLine(t *testing.T) {
	e, err := ParseLine("2026-09-01T10:00:05Z GET /api/users 200 45ms 2048")
	if err != nil {
		t.Fatal(err)
	}
	if !e.Time.Equal(time.Date(2026, 9, 1, 10, 0, 5, 0, time.UTC)) {
		t.Errorf("time %v", e.Time)
	}
	if e.Method != "GET" || e.Path != "/api/users" || e.Status != 200 || e.Latency != 45*time.Millisecond || e.Bytes != 2048 {
		t.Errorf("got %+v", e)
	}
}

func TestParseLineRejects(t *testing.T) {
	for _, line := range []string{
		"not a log line",
		"2026-09-01 GET /x 200 5ms 10",
		"2026-09-01T10:00:00Z GET /x 999 5ms 10",
		"2026-09-01T10:00:00Z GET /x 200 fast 10",
		"2026-09-01T10:00:00Z GET /x 200 5ms -1",
	} {
		if _, err := ParseLine(line); err == nil {
			t.Errorf("ParseLine(%q): want an error", line)
		}
	}
}

func TestParseCountsMalformed(t *testing.T) {
	log := strings.Join([]string{
		"# comment",
		"2026-09-01T10:00:00Z GET /health 200 10ms 120",
		"",
		"garbage",
		"2026-09-01T10:00:01Z POST /login 401 100ms 64",
	}, "\n")
	res, err := Parse(strings.NewReader(log))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Entries) != 2 || res.Malformed != 1 {
		t.Errorf("%d entries, %d malformed; want 2 and 1", len(res.Entries), res.Malformed)
	}
}
