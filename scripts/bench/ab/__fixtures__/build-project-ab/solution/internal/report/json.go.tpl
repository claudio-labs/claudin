package report

import (
	"encoding/json"
	"io"

	"example.com/logstat/internal/stats"
)

type jsonReport struct {
	Requests  int            `json:"requests"`
	Malformed int            `json:"malformed"`
	Bytes     int64          `json:"bytes"`
	Status    map[string]int `json:"status"`
	LatencyMS jsonLatency    `json:"latency_ms"`
	TopPaths  []jsonPath     `json:"top_paths"`
}

type jsonLatency struct {
	P50 int64 `json:"p50"`
	P95 int64 `json:"p95"`
	P99 int64 `json:"p99"`
}

type jsonPath struct {
	Path  string `json:"path"`
	Count int    `json:"count"`
}

// JSON writes the report as one JSON object. Every status class is present,
// and latencies are whole milliseconds.
func JSON(w io.Writer, s stats.Summary, malformed int) error {
	r := jsonReport{
		Requests:  s.Requests,
		Malformed: malformed,
		Bytes:     s.Bytes,
		Status:    map[string]int{},
		LatencyMS: jsonLatency{P50: s.P50.Milliseconds(), P95: s.P95.Milliseconds(), P99: s.P99.Milliseconds()},
		TopPaths:  make([]jsonPath, 0, len(s.TopPaths)),
	}
	for _, c := range stats.Classes {
		r.Status[c] = s.ByClass[c]
	}
	for _, p := range s.TopPaths {
		r.TopPaths = append(r.TopPaths, jsonPath{Path: p.Path, Count: p.Count})
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(r)
}
