First, commit the work from before on main, with a conventional commit message.

A teammate pushed a `feature/bulk` branch that adds `POST /items/bulk`. Use an Explore agent
to review `git diff main...feature/bulk` against docs/SPEC.md and report any bugs.

Then check out `feature/bulk`, fix what the review found plus anything else that breaks the
spec, add regression tests, make `bun test` pass, and commit on the branch with a
conventional commit message.
