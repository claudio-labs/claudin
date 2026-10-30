This is inventory-svc, a small Bun HTTP service. I need two features added:

- `PATCH /items/:id` (partial updates)
- tag filtering on `GET /items` (`?tag=...`)

Both are already specified in docs/SPEC.md and docs/API.md. Implement them exactly as the
docs say, including the error codes and the edge cases.

Start in plan mode: use EnterPlanMode, read the docs and the code, and write a plan. The plan
must end with a `## Tasks` section listing the steps as `- [ ] ...` items. Once I approve it,
implement the plan and mark each task done as you finish it.

Add tests for the new behaviour and make `bun test` pass.

Then start the server with `sh scripts/start.sh` and check it with curl against the port in
`config/port`: hit `/health` and a filtered `/items?tag=...`. Stop the server when you're
done with it.

Don't commit anything.
