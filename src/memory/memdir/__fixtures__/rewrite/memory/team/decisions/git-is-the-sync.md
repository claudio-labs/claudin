---
name: git-is-the-sync
description: Team memory reaches teammates through commits; nothing uploads it
type: project
scope: memory
impact: structural
paths: src/memory/**, docs/memory/**
---

**Decision:** the team directory is tracked by git, and nothing else moves it.
**Why:** one mechanism fewer, and every change is reviewed like code.
**What changes for a teammate:** commit memory files together with the change they describe.
**Rejected:** a sync service, which needed an account most contributors did not have.
**Evidence:** the plan of 2026-09 that removed the upload.
