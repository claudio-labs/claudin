# inventory-svc HTTP API

Endpoint reference for inventory-svc. The rules behind each endpoint (validation, ordering,
atomicity) are specified in SPEC.md; this page shows the shapes on the wire and the errors
each endpoint can return. Endpoints and parameters marked **planned** are specified and
stable, so clients may be written against them, but the server does not serve them yet.

## Conventions

- Requests and responses are JSON (`content-type: application/json`), encoded as UTF-8.
- The base URL is `http://localhost:<port>`, where the port is the number in `config/port`.
- Bodies sent with `POST` and `PATCH` must be JSON objects; anything else is `invalid_json`.
- Listings are always ordered by the numeric part of the id, so `itm_2` precedes `itm_10`.
- Timestamps are ISO 8601 strings in UTC with milliseconds, and only the server sets them.
- An item always has exactly five fields: `id`, `name`, `qty`, `tags` and `updatedAt`.
- Examples below show the status line followed by the body; headers are omitted for brevity.

## The item object

| Field       | Type            | Set by | Notes                                                          |
|-------------|-----------------|--------|----------------------------------------------------------------|
| `id`        | string          | server | `itm_<n>`; never reused while the process runs                 |
| `name`      | string          | client | trimmed before storing; never blank                            |
| `qty`       | integer         | client | units on the shelf; 0 means out of stock, not unknown           |
| `tags`      | array of string | client | lowercased, trimmed, deduplicated and sorted by the server      |
| `updatedAt` | string          | server | ISO 8601 UTC with milliseconds; refreshed on every change       |

Clients must not depend on the order of the fields inside an object. The server never adds
a sixth field to an item; anything new would arrive in a separate envelope key instead.

## Error format

Every error has the same envelope, whatever the endpoint and whatever the status code:

```json
{ "error": { "code": "invalid_qty", "message": "qty must be an integer >= 0" } }
```

Clients branch on `code`, which is stable across versions. The `message` is English text for
humans and logs, it may change in any release, and it must never be parsed. A client that
receives a code it does not recognise treats the request as failed, never as successful.

## Error codes

| Code              | Status | Raised by                 | Meaning                                                  |
|-------------------|--------|---------------------------|----------------------------------------------------------|
| `invalid_json`    | 400    | any POST or PATCH         | The body does not parse, or it is not a JSON object      |
| `invalid_name`    | 400    | POST /items, PATCH        | The name is missing, not a string, or blank once trimmed |
| `invalid_qty`     | 400    | POST /items, PATCH        | The quantity is not an integer greater than or equal to 0 |
| `invalid_tags`    | 400    | POST /items, PATCH        | The tags field is present but not an array of strings    |
| `unknown_field`   | 400    | PATCH /items/:id          | The body holds a field other than name, qty or tags      |
| `empty_patch`     | 400    | PATCH /items/:id          | The body is `{}`, so there is nothing to change          |
| `batch_too_large` | 400    | POST /items/bulk          | The batch holds more than 100 entries                    |
| `duplicate_name`  | 400    | POST /items/bulk          | A name is already in the store, or repeats in the batch  |
| `invalid_item`    | 400    | POST /items/bulk          | An entry fails validation, or `items` is not an array    |
| `not_found`       | 404    | any                       | No item has that id, or the service has no such route    |
| `internal`        | 500    | any                       | An unexpected failure; always a bug in the server        |

## GET /health

Liveness check for monitors and for the ordering script, which calls it before an import.
It never touches the store, never logs, and has no error responses of its own; a monitor
that gets no answer within a second should assume the process is gone and restart it.

```http
GET /health
→ 200 OK   { "status": "ok" }
```

## GET /items

Lists every item in a `{"items": [...]}` envelope, ordered by numeric id. There is no
pagination: the workshop holds a few hundred items and the whole list fits in one response.

```http
GET /items
→ 200 OK
{ "items": [
  { "id": "itm_1", "name": "Widget", "qty": 25, "tags": ["hardware", "small"], "updatedAt": "2026-09-02T10:15:00.000Z" },
  { "id": "itm_2", "name": "Gadget", "qty": 4, "tags": ["electronics"], "updatedAt": "2026-09-03T08:00:00.000Z" }
] }
```

### Query parameter `tag` (planned)

The optional `tag` parameter narrows the listing to the items that carry the named tag. The
match ignores case, so `Office` and `office` select the same items. Several tags may be given
separated by commas, and then an item is listed only when it carries every one of them; each
extra tag can only remove items, never add them. Spaces around each tag are ignored, and the
result keeps the usual numeric id order. A tag that no item carries is not an error: the
answer is `200` with an empty list. Leaving the parameter out lists everything, as before.

```http
GET /items?tag=Electronics,office
→ 200 OK
{ "items": [
  { "id": "itm_5", "name": "Desk Lamp", "qty": 7, "tags": ["electronics", "office"], "updatedAt": "2026-09-11T16:20:00.000Z" }
] }

GET /items?tag=garden
→ 200 OK   { "items": [] }
```

## GET /items/:id

Returns one item, with all five fields, or `404 not_found` when no item has that id. The id
is matched exactly; `ITM_3` and `itm_03` do not find `itm_3`, since ids are never normalized.

```http
GET /items/itm_3
→ 200 OK
{ "id": "itm_3", "name": "Bolt M6", "qty": 400, "tags": ["fastener", "hardware"], "updatedAt": "2026-09-05T14:30:00.000Z" }

GET /items/itm_404
→ 404 Not Found   { "error": { "code": "not_found", "message": "no item with id itm_404" } }
```

## POST /items

Creates one item and returns it with `201`. `name` and `qty` are required and `tags` defaults
to an empty list. Before storing, the server trims the name and lowercases, trims, dedupes
and sorts the tags. The new id is one more than the largest id in use. Names need not be
unique here; only bulk imports reject a clash. Fields other than the three are ignored.

```http
POST /items   { "name": "  Hex Key Set ", "qty": 12, "tags": ["Tools", "hardware", "tools"] }
→ 201 Created
{ "id": "itm_9", "name": "Hex Key Set", "qty": 12, "tags": ["hardware", "tools"], "updatedAt": "2026-10-01T09:00:00.000Z" }

POST /items   { "name": "Hex Key Set", "qty": -2 }
→ 400 Bad Request   { "error": { "code": "invalid_qty", "message": "qty must be an integer >= 0" } }

POST /items   { "name": "   ", "qty": 2 }
→ 400 Bad Request   { "error": { "code": "invalid_name", "message": "name must be a non-empty string" } }
```

## PATCH /items/:id (planned)

Changes any subset of `name`, `qty` and `tags` on one existing item and answers `200` with
the full item as it now stands. Each field present is validated exactly as in `POST /items`;
`tags`, when present, replaces the whole list after normalization. The server refreshes
`updatedAt` on every successful update. A body of `{}` is `empty_patch`, a field outside the
three is `unknown_field` (this includes `id` and `updatedAt`), and an id that matches no item
is `404 not_found`. A refused request changes nothing at all, not even the timestamp, even
when only one of several fields was wrong.

```http
PATCH /items/itm_2   { "qty": 9, "tags": ["Electronics", "Fragile"] }
→ 200 OK
{ "id": "itm_2", "name": "Gadget", "qty": 9, "tags": ["electronics", "fragile"], "updatedAt": "2026-10-02T15:12:44.120Z" }

PATCH /items/itm_2   { "quantity": 9 }
→ 400 Bad Request   { "error": { "code": "unknown_field", "message": "unknown field: quantity" } }

PATCH /items/itm_2   {}
→ 400 Bad Request   { "error": { "code": "empty_patch", "message": "nothing to update" } }

PATCH /items/itm_2   { "name": "Gadget Pro", "qty": 1.5 }
→ 400 Bad Request   { "error": { "code": "invalid_qty", "message": "qty must be an integer >= 0" } }

PATCH /items/itm_404   { "qty": 1 }
→ 404 Not Found   { "error": { "code": "not_found", "message": "no item with id itm_404" } }
```

## POST /items/bulk (planned)

Creates up to 100 items in one atomic request. The body is `{"items": [...]}`, and each entry
is shaped like the body of `POST /items` and validated the same way. A batch of 100 is
accepted; 101 or more is `batch_too_large`, decided before any entry is examined. A name
that clashes, ignoring case and surrounding spaces, with an item in the store or with an
earlier entry of the same batch is `duplicate_name`. An entry that fails validation makes the
whole request `invalid_item`, and the message names its index. On any error nothing is
created. On success the answer is `201` with the new items in request order.

```http
POST /items/bulk
{ "items": [
  { "name": "Washer M6", "qty": 500, "tags": ["fastener"] },
  { "name": "Nut M6", "qty": 450, "tags": ["Fastener", "hardware"] }
] }
→ 201 Created
{ "created": [
  { "id": "itm_9", "name": "Washer M6", "qty": 500, "tags": ["fastener"], "updatedAt": "2026-10-03T06:00:00.000Z" },
  { "id": "itm_10", "name": "Nut M6", "qty": 450, "tags": ["fastener", "hardware"], "updatedAt": "2026-10-03T06:00:00.000Z" }
] }

POST /items/bulk   { "items": [ { "name": "Washer M6", "qty": 5 }, { "name": " washer m6", "qty": 1 } ] }
→ 400 Bad Request   { "error": { "code": "duplicate_name", "message": "items[1]: name \"washer m6\" is repeated" } }

POST /items/bulk   { "items": [ { "name": "Spring", "qty": 5 }, { "name": "Clip", "qty": -1 } ] }
→ 400 Bad Request   { "error": { "code": "invalid_item", "message": "items[1]: qty must be an integer >= 0" } }
```

In the last example `Spring` is not created either: the request is refused as a whole, and a listing
made right after it shows the store exactly as it was.

## Curl cheatsheet

```sh
PORT=$(cat config/port)
curl -s "localhost:$PORT/health"
curl -s "localhost:$PORT/items?tag=hardware"
curl -s -X PATCH "localhost:$PORT/items/itm_1" -d '{"qty": 30}'
curl -s -X POST "localhost:$PORT/items/bulk" -d '{"items": [{"name": "Spring", "qty": 5}]}'
```

## Client notes

Requests are independent and there is no session state, so a client may retry any `GET`
freely. `PATCH` is safe to retry as long as the body is the same, because applying the same
fields twice leaves the item as it was after the first attempt, apart from the timestamp.
`POST /items` is not: retrying a creation after a timeout may create a second row with the
same name. `POST /items/bulk` refuses names that already exist, so a retried import either
succeeds the first time or fails with `duplicate_name` the second, which the ordering script
treats as "already imported" after checking the listing.

## Document history

- 0.4.0 — `PATCH /items/:id`, the `tag` filter and `POST /items/bulk` specified as planned.
- 0.3.0 — `POST /items` and the validation error codes; 0.2.0 was the first version of this page, with `GET /health`, `GET /items` and `GET /items/:id`.
