// Command logstat summarizes an access log: requests per status class,
// latency percentiles and the busiest paths.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"example.com/logstat/internal/filter"
	"example.com/logstat/internal/logparse"
	"example.com/logstat/internal/report"
	"example.com/logstat/internal/stats"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run is the whole command. It returns the exit status: 0 on success, 1 when
// the log cannot be read, 2 on a usage error.
func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("logstat", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: logstat [flags] <access.log>")
		fs.PrintDefaults()
	}
	top := fs.Int("top", 3, "number of paths in the busiest-paths list")
	status := fs.String("status", "", "keep one status class: 2xx, 3xx, 4xx or 5xx")
	since := fs.String("since", "", "keep requests at or after this RFC 3339 time")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if fs.NArg() != 1 {
		fs.Usage()
		return 2
	}

	opts := filter.Options{Status: *status}
	if *since != "" {
		t, err := time.Parse(time.RFC3339, *since)
		if err != nil {
			fmt.Fprintf(stderr, "logstat: --since: %v\n", err)
			return 2
		}
		opts.Since = t
	}
	if err := opts.Validate(); err != nil {
		fmt.Fprintf(stderr, "logstat: %v\n", err)
		return 2
	}

	f, err := os.Open(fs.Arg(0))
	if err != nil {
		fmt.Fprintf(stderr, "logstat: %v\n", err)
		return 1
	}
	defer f.Close()
	parsed, err := logparse.Parse(f)
	if err != nil {
		fmt.Fprintf(stderr, "logstat: %v\n", err)
		return 1
	}

	summary := stats.Summarize(filter.Apply(parsed.Entries, opts), *top)
	if err := report.Text(stdout, summary, parsed.Malformed); err != nil {
		fmt.Fprintf(stderr, "logstat: %v\n", err)
		return 1
	}
	return 0
}
