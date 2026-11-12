# Keep-alive on the 1h tier, simulated — 2026-11-11, branch perf/census-2026-11-11

A replay, not a live run: no request was sent. `scripts/bench/tokens/keepalive-sim.ts`
walked the main-thread calls recorded since 2026-11-04 and priced what a ping at 55
minutes of idle (then every 55, at most K times) would have saved and cost. The header
of the script states the model and what it cannot see.

```
bun scripts/bench/tokens/keepalive-sim.ts --since=2026-11-04 --exclude=d44cf59f --as=claude-opus-5-5 --as=claude-fable-5-2
```

```
=== KEEP-ALIVE 1H SIM since 2026-11-04 ===
window=7.7d  main threads=24  calls=3495  projects=3  ping at 55min then every 55min, TTL 60min  excluded=d44cf59f
recorded models: claude-opus-5-5×3471  claude-sonnet-5-5×24

rates, $/Mtok (priceFor in session-census.ts):
  claude-opus-5-5        input 4  write5m 5  write1h 8  read 0.2  output 20  (one 1h write = 40 reads)
  claude-fable-5-2       input 8  write5m 10  write1h 16  read 0.2  output 40  (one 1h write = 80 reads)
  claude-sonnet-5-5      input 2  write5m 2.5  write1h 4  read 0.2  output 10  (one 1h write = 20 reads)

pricing              K  expiries  rewrote  covered  pings useful/wasted  avoided$   pings$  extra reads$      net$  net/week  % of main   main$  end pings≤
as recorded          1         8        8        3                3 / 6     $3.07    $0.58         $0.63    +$1.86    +$1.69      0.51%  $367.18       $1.23
as recorded          2         8        8        5                7 / 7     $7.93    $0.98         $5.24    +$1.71    +$1.56      0.47%  $367.18       $2.44
as recorded          3         8        8        5               8 / 10     $7.93    $1.29         $5.24    +$1.41    +$1.28      0.38%  $367.18       $3.65
as claude-opus-5-5   1         8        8        3                3 / 6     $3.07    $0.58         $0.63    +$1.86    +$1.69      0.50%  $367.62       $1.23
as claude-opus-5-5   2         8        8        5                7 / 7     $7.93    $0.98         $5.24    +$1.71    +$1.56      0.47%  $367.62       $2.44
as claude-opus-5-5   3         8        8        5               8 / 10     $7.93    $1.29         $5.24    +$1.41    +$1.28      0.38%  $367.62       $3.65
as claude-fable-5-2  1         8        8        3                3 / 6     $6.22    $0.58         $0.63    +$5.00    +$4.56      0.97%  $513.91       $1.23
as claude-fable-5-2  2         8        8        5                7 / 7    $16.07    $0.98         $5.24    +$9.85    +$8.98      1.92%  $513.91       $2.44
as claude-fable-5-2  3         8        8        5               8 / 10    $16.07    $1.29         $5.24    +$9.54    +$8.70      1.86%  $513.91       $3.65

tail estimate (a thread's median write after a gap under 5min), over the 5 gaps K=3 covers: p50 1k  min 1k  max 1k tokens
end pings≤ is NOT in the net: up to K pings after each thread's last call, if its process stayed open.

5 largest covered gaps (K=3, by tokens avoided):
session   minutes pings  ctx before→after   tail  avoided calls until reset
67e6e961      166     3         451k→352k     1k     351k                22
67e6e961      137     2         494k→274k     1k     273k                95
4ced9fdb       60     1         156k→159k     1k     145k                 4
4ced9fdb       65     1         136k→136k     1k     125k                19
4ced9fdb       85     1         272k→134k     1k     123k                23
```

## How to read it

Each row is one policy under one price list. `net$` is `avoided$ − pings$ − extra reads$`.
`avoided$` is the rewrite a covered gap no longer pays, at the 1h write price less the
read that replaces it. `extra reads$` is what the idle-gap clip had removed for free and
a warm thread keeps reading on every call until its next reset. That term is the same
dollar amount on Opus 5.5 and Fable 5.2 (both read at $0.20/M), while `avoided$` doubles
with the write price, which is why the net is about +$1.50 a week on Opus 5.5 and about
+$9 a week on Fable 5.2 for K=2. The 137-minute gap in 67e6e961 shows the term at work:
it avoids 273k of writes ($2.13 on Opus 5.5) and then carries 220k through 95 calls
($4.18), a loss on Opus 5.5 and a draw on Fable 5.2; K=1 does not cover it, which is why
K=1 has the best net at Opus 5.5 prices. `end pings≤` is not in the net: it is the ceiling
on pings sent after a thread's last call if every process stayed open, and it is larger
than the Opus 5.5 net for K=2 and K=3. The sample is 8 expiries, 5 of them covered, in two
sessions; a week with one more long thread after a pause moves every number here, so
this says the sign on Fable 5.2 is plausibly positive, not how large it is.
