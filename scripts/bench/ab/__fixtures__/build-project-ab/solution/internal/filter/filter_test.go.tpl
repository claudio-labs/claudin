package filter

import (
	"strings"
	"testing"
	"time"

	"example.com/logstat/internal/logparse"
)

func TestApply(t *testing.T) {
	at := func(m int) time.Time { return time.Date(2026, 9, 1, 10, m, 0, 0, time.UTC) }
	entries := []logparse.Entry{
		{Time: at(0), Method: "GET", Path: "/a", Status: 200},
		{Time: at(1), Method: "POST", Path: "/b", Status: 500},
		{Time: at(2), Method: "GET", Path: "/c", Status: 503},
		{Time: at(3), Method: "post", Path: "/d", Status: 201},
	}
	for _, c := range []struct {
		name string
		opts Options
		want string
	}{
		{"everything", Options{}, "/a /b /c /d"},
		{"method, any case", Options{Method: "Post"}, "/b /d"},
		{"method and status", Options{Method: "get", Status: "5xx"}, "/c"},
		{"since is inclusive", Options{Since: at(2)}, "/c /d"},
	} {
		var got []string
		for _, e := range Apply(entries, c.opts) {
			got = append(got, e.Path)
		}
		if strings.Join(got, " ") != c.want {
			t.Errorf("%s: got %v, want %s", c.name, got, c.want)
		}
	}
}
