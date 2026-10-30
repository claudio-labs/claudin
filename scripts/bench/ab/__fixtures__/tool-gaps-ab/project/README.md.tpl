# inventory-svc

A small inventory service: a JSON HTTP API over an in-memory store, seeded from
`data/items.json` at startup. Bun only, no dependencies.

## Docs

The product rules live in `docs/`:

- `docs/SPEC.md` — the product specification (data model, validation, errors,
  filtering, partial updates, bulk import). It is normative.
- `docs/API.md` — the endpoint reference with request and response examples.

When the code and the docs disagree, the docs win and the code is the bug.

## Running

```sh
bun test              # the test suite (bun test src)
sh scripts/start.sh   # start the server in the background
```

The server listens on the port written in `config/port` (one number, no
newline required). That file is local to each checkout and is not committed.
The server's output goes to `server.log`.

## Layout

- `src/store.ts` — the in-memory store and input validation
- `src/server.ts` — the HTTP handler (`createHandler`) and the entry point
- `data/items.json` — seed data
