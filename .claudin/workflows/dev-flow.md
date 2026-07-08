---
name: dev-flow
description: Backlog → dev → review → test → done
steps:
  - name: development
    agents: [coder]
  - name: code-review
    agents: [reviewer-bugs, reviewer-perf]
    handbackTo: [development]
  - name: test
    agents: [tester]
    handbackTo: [development]
  - name: done
---
Follow the repository's house style. Prefer small, verifiable changes.
