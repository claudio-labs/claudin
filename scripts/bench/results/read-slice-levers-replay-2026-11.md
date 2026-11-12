# Read-slice levers, replayed over 11-04..11 (2026-11-11)

```
$ NODE_ENV=test bun --preload ./src/stubs/test-preload.ts \
    scripts/bench/tokens/reread-census.ts --levers --since=2026-11-04 --exclude=d44cf59f

# Read-lever replay since 2026-11-04 — 24 main transcripts

  3499  main API calls
   670  range Reads replayed
   189  of them alone in their API call (5.4% of the calls): the most a lever could save
    20  range Reads unresolvable (file gone, or shorter than the range)
    20  content Greps unresolvable (a matched file gone or shorter)

one saved call = $0.105; one added token = $8/M

mechanism            triggers     served      saved    % calls    repeats   returned   added ch  added tok      net $
A grep bodies             212          7          4       0.1%          0     468844     461135     115284      -0.50
B range → symbol          314          6          0       0.0%          8     448771     443571     110893      -0.89
C whole on 3rd             13          6          2       0.1%          1     150927     137466      34367      -0.06

A grep bodies: FAIL (saved calls 0.1% of main API calls, under 2%; net $-0.50, not above 0)
B range → symbol: FAIL (saved calls 0.0% of main API calls, under 2%; net $-0.89, not above 0)
C whole on 3rd: FAIL (saved calls 0.1% of main API calls, under 2%; net $-0.06, not above 0)
```

How to read it: each row replays one mechanism alone over the main threads, against the reads they really made. `triggers` are the calls it would have answered with more than was asked, and every one of them pays `returned` chars whether or not a Read followed; `served` are the follow-up range Reads whose lines it had already delivered, and only the ones alone in their API call are `saved` calls, which is what the 2% gate counts (70 of 3,499 here, out of 189 range Reads that were alone at all). `repeats` are Reads the lever's lines cover that the thread's own earlier reads covered too: the model made them with the lines already in context, so they are not credited, and adding them to `served` gives the reading most favourable to the lever. `added` is `returned` less the chars of the served Reads, and `net $` prices it once, at the cache-write rate, against $0.105 a saved call; the added tokens are also re-read by every later call of the session, which this does not charge, so `net $` errs in the levers' favour. Lines and symbols come from the files as they are on disk today, not as they were when the session read them, so a file edited since can put a recorded range in a different symbol; a range the file no longer reaches is counted as unresolvable and left out. The script's header defines the three mechanisms and their limits; the transcripts of other live sessions keep growing, so a rerun moves the counts by a few calls.
