// Package stats turns parsed entries into the numbers logstat reports.
package stats

import (
	"fmt"
	"math"
	"sort"
	"time"

	"example.com/logstat/internal/logparse"
)

// Classes are the status classes a Summary counts, in report order.
var Classes = []string{"2xx", "3xx", "4xx", "5xx"}

// PathCount is one row of the busiest-paths list.
type PathCount struct {
	Path  string
	Count int
}

// Summary is everything logstat reports about a set of entries.
type Summary struct {
	Requests int
	Bytes    int64
	// ByClass counts requests per status class, e.g. "4xx".
	ByClass map[string]int
	// P50, P95 and P99 are nearest-rank latency percentiles.
	P50, P95, P99 time.Duration
	// TopPaths lists the busiest paths, most requests first.
	TopPaths []PathCount
}

// Summarize computes a Summary; top caps the busiest-paths list.
func Summarize(entries []logparse.Entry, top int) Summary {
	s := Summary{Requests: len(entries), ByClass: map[string]int{}}
	latencies := make([]time.Duration, 0, len(entries))
	perPath := map[string]int{}
	for _, e := range entries {
		s.Bytes += e.Bytes
		s.ByClass[Class(e.Status)]++
		latencies = append(latencies, e.Latency)
		perPath[e.Path]++
	}
	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	s.P50 = Percentile(latencies, 50)
	s.P95 = Percentile(latencies, 95)
	s.P99 = Percentile(latencies, 99)
	s.TopPaths = topPaths(perPath, top)
	return s
}

// Class maps a status code to its class, e.g. 404 to "4xx".
func Class(status int) string {
	return fmt.Sprintf("%dxx", status/100)
}

// Percentile returns the nearest-rank p-th percentile (0 < p <= 100) of an
// ascending slice, or 0 for an empty one.
func Percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	rank := int(math.Ceil(p * float64(len(sorted)) / 100))
	if rank < 1 {
		rank = 1
	}
	return sorted[rank-1]
}

// topPaths orders paths by request count, then by path, and keeps the first top.
func topPaths(perPath map[string]int, top int) []PathCount {
	rows := make([]PathCount, 0, len(perPath))
	for p, n := range perPath {
		rows = append(rows, PathCount{Path: p, Count: n})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Count != rows[j].Count {
			return rows[i].Count > rows[j].Count
		}
		return rows[i].Path < rows[j].Path
	})
	if top >= 0 && len(rows) > top {
		rows = rows[:top]
	}
	return rows
}
