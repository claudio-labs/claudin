---
name: conventions-real-database
description: Storage tests run against a disposable real database, never a mock
type: feedback
---

Integration tests for the storage layer use the disposable database, not mocks.

**Why:** a mocked suite stayed green while a migration corrupted staging data.

**How to apply:** new storage tests go through the shared database fixture.
