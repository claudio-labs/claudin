// Package logparse reads logstat's access-log format, one request per line:
//
//	2026-09-01T10:00:05Z GET /api/users 200 45ms 2048
//
// timestamp (RFC 3339), method, path, status, latency, response bytes.
package logparse

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// Entry is one request.
type Entry struct {
	Time    time.Time
	Method  string
	Path    string
	Status  int
	Latency time.Duration
	Bytes   int64
}

// Result holds every entry that parsed, and how many lines did not.
type Result struct {
	Entries   []Entry
	Malformed int
}

// Parse reads a whole log. Blank lines and # or // comments are skipped; any other
// line that does not parse is counted in Result.Malformed. Only a read error
// fails the call.
func Parse(r io.Reader) (Result, error) {
	var res Result
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "//") {
			continue
		}
		e, err := ParseLine(line)
		if err != nil {
			res.Malformed++
			continue
		}
		res.Entries = append(res.Entries, e)
	}
	return res, sc.Err()
}

// ParseLine parses one log line.
func ParseLine(line string) (Entry, error) {
	f := strings.Fields(line)
	if len(f) != 6 {
		return Entry{}, fmt.Errorf("want 6 fields, got %d", len(f))
	}
	t, err := time.Parse(time.RFC3339, f[0])
	if err != nil {
		return Entry{}, fmt.Errorf("timestamp: %w", err)
	}
	status, err := strconv.Atoi(f[3])
	if err != nil || status < 100 || status > 599 {
		return Entry{}, fmt.Errorf("status %q", f[3])
	}
	latency, err := parseLatency(f[4])
	if err != nil {
		return Entry{}, err
	}
	bytes, err := strconv.ParseInt(f[5], 10, 64)
	if err != nil || bytes < 0 {
		return Entry{}, fmt.Errorf("bytes %q", f[5])
	}
	return Entry{Time: t, Method: f[1], Path: f[2], Status: status, Latency: latency, Bytes: bytes}, nil
}

// parseLatency reads a latency in milliseconds, e.g. "45ms".
func parseLatency(s string) (time.Duration, error) {
	ms, ok := strings.CutSuffix(s, "ms")
	if !ok {
		return 0, fmt.Errorf("latency %q: want milliseconds, e.g. 45ms", s)
	}
	n, err := strconv.Atoi(ms)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("latency %q", s)
	}
	return time.Duration(n) * time.Millisecond, nil
}
