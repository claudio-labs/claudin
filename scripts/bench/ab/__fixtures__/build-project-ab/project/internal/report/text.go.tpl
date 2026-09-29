// Package report renders a stats.Summary.
package report

import (
	"fmt"
	"io"
	"strings"

	"example.com/logstat/internal/stats"
)

// Text writes the human-readable report: one "label value" row per number,
// then the busiest paths.
func Text(w io.Writer, s stats.Summary, malformed int) error {
	var b strings.Builder
	row := func(label string, value any) {
		fmt.Fprintf(&b, "%-10s %v\n", label, value)
	}
	row("requests", s.Requests)
	row("malformed", malformed)
	row("bytes", s.Bytes)
	for _, c := range stats.Classes {
		row(c, s.ByClass[c])
	}
	row("p50", s.P50)
	row("p95", s.P95)
	b.WriteString("top paths\n")
	for _, p := range s.TopPaths {
		fmt.Fprintf(&b, "  %4d  %s\n", p.Count, p.Path)
	}
	_, err := io.WriteString(w, b.String())
	return err
}
