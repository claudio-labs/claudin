# Changelog

All notable changes to inventory-svc. The format follows Keep a Changelog and the
version numbers follow the rules in docs/SPEC.md §10.

## [0.5.0] — unreleased

### Added

- `POST /items/bulk`: import up to 100 items in one request, with the
  `batch_too_large`, `duplicate_name` and `invalid_item` error codes
  described in docs/SPEC.md §8. The ordering script can now send a supplier
  catalogue in one call instead of one `POST /items` per row.
- `Store.createMany`, which creates several items in order and reports a
  failing entry by its index.

### Changed

- Field validation moved from `src/store.ts` to `src/validate.ts`, so the
  store and the bulk import share one set of rules. `src/store.ts` still
  re-exports `ApiError` and the `normalize*` helpers for existing callers.
- docs/API.md: the bulk endpoint is no longer marked as planned.

## [0.4.0] — 2026-09-30

### Changed

- Validation of names, quantities and tags moved into the store, so every
  path that creates an item goes through the same checks.

## [0.3.0] — 2026-08-12

### Added

- `POST /items`, with the `invalid_name`, `invalid_qty` and `invalid_tags`
  error codes.
