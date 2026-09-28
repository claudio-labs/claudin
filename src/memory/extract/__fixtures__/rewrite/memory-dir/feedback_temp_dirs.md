---
name: prefer-real-temp-dirs
description: Tests build their own scratch directories instead of mocking the filesystem
type: feedback
---

Give every test a fresh directory from mkdtemp and delete it afterwards.

**Why:** a mocked filesystem hid a path bug that only showed on a real disk.

**How to apply:** reach for a stub only at the network or model boundary.
