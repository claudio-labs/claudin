`logstat` is a small Go CLI that summarizes access logs. I need two things.

**Questions.** Answer these from the code in a new file `ANSWERS.md` at the repository root, one line per answer in the form `Q1: <answer>`, with just the answer and no explanation:

1. Which exit status does logstat return for a usage error, and which when the log cannot be read? Answer as `usage=N read=N`.
2. Which HTTP status codes does `ParseLine` accept? Answer as `MIN-MAX`.
3. Which two latency percentiles does `stats.Summarize` compute? Answer as `pNN pNN`.
4. How many characters wide is the label column of the text report?
5. How many `func Test…` functions does the project define in total?
6. What error message does logstat print for `--status 6xx`, after the `logstat: ` prefix?

**Changes.**

1. Make the default of `--top` 3 instead of 5.
2. Rename the text report's `top paths` heading to `busiest paths`.
3. Treat lines starting with `//` as comments, like lines starting with `#`.

Keep `go vet ./...` and `go test ./...` passing, and don't commit.
