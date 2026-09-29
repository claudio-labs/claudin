// Package filter narrows the parsed entries down before they are summarized.
package filter

import (
	"fmt"
	"strings"
	"time"

	"example.com/logstat/internal/logparse"
	"example.com/logstat/internal/stats"
)

// Options selects entries. A zero field keeps everything.
type Options struct {
	// Since keeps entries at or after this time.
	Since time.Time
	// Status keeps one status class, e.g. "5xx".
	Status string
	// Method keeps one request method, compared case-insensitively.
	Method string
}

// Validate rejects an option no entry could ever match.
func (o Options) Validate() error {
	if o.Status == "" {
		return nil
	}
	for _, c := range stats.Classes {
		if o.Status == c {
			return nil
		}
	}
	return fmt.Errorf("--status %q: want one of 2xx, 3xx, 4xx, 5xx", o.Status)
}

// Apply returns the entries every set option keeps, in their original order.
func Apply(entries []logparse.Entry, o Options) []logparse.Entry {
	var kept []logparse.Entry
	for _, e := range entries {
		if !o.Since.IsZero() && e.Time.Before(o.Since) {
			continue
		}
		if o.Status != "" && stats.Class(e.Status) != o.Status {
			continue
		}
		if o.Method != "" && !strings.EqualFold(e.Method, o.Method) {
			continue
		}
		kept = append(kept, e)
	}
	return kept
}
