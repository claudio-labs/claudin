# inventory-svc — Product Specification

This document is the normative description of inventory-svc. Where the code and this text
disagree, this text wins and the code is the bug. The endpoint-by-endpoint reference, with
request and response examples, lives in API.md; this file explains the rules behind them.

## 1. Purpose and scope

inventory-svc keeps a list of stock items for the workshop and answers a handful of HTTP
calls about them. It is deliberately small: one process, one in-memory store seeded from a
JSON file at startup, no authentication, and no persistence beyond the life of the process.
It exists so that the front desk tablet and the ordering scripts agree on what is in stock,
and so that both can be tested against a service whose behaviour is written down somewhere.

The service is consumed by two clients today. The tablet app reads the list and edits single
items when someone counts a shelf; the nightly ordering script reads the list, filters it by
tag, and occasionally imports a supplier's catalogue in one go. Both clients are maintained
by the same team, but they are released on different schedules, so the contract below is
treated as stable: a change to it is a version bump and a note in the changelog.

## 2. History

Version 0.1 was a single script that printed the seed file. Version 0.2 added the HTTP
handler and the `GET /items` listing; 0.3 added creation through `POST /items` and the
validation rules for names and quantities; 0.4 moved validation into the store so that every
path that creates or changes an item goes through the same checks. The next two milestones
add partial updates and tag filtering (0.4.x, requested by the tablet team) and bulk import
(0.5, requested by the ordering script). Their rules are already specified below, so that
both clients can be written against them before the server ships them.

Earlier drafts of this document described a SQLite backend and a separate admin interface.
Both were dropped during the 0.3 review: the workshop restarts the machine every night, the
seed file is regenerated from the ordering system anyway, and nobody wanted to own a schema
migration for a list that fits in a single screen. Those drafts are kept in the wiki for the
record but are not normative, and nothing in them should be read as a promise.

## 3. Data model

An item is a JSON object with exactly five fields: `id`, `name`, `qty`, `tags` and
`updatedAt`. No other field is ever stored or returned, and clients must not rely on the
order in which the fields appear in a response body.

### 3.1 Identifiers

Identifiers are assigned by the server and never chosen by a client. They have the form
`itm_<n>`, where `n` is a positive integer, one greater than the largest number currently in
use. An identifier is never reused while the process runs. Whenever the service returns more
than one item, the items are ordered by that number, compared numerically and not as text,
so `itm_2` comes before `itm_10`; this applies to every listing, filtered or not.

### 3.2 Names

A name is free text chosen by the client. Leading and trailing whitespace is removed before
the name is stored, and the stored value is what every response shows. A name that is empty
once trimmed is rejected with `invalid_name`, both when an item is created and when a name
is changed later; there is no way to blank out a name. Names are not required to be unique
when items are created one at a time, because the tablet sometimes needs two "Misc" rows,
but see section 8 for the stricter rule that applies to imports.

### 3.3 Quantities

A quantity is the number of units on the shelf. It must be a JSON number that is an integer
greater than or equal to zero; negative numbers, fractions and numeric strings such as "3"
are all rejected with `invalid_qty`. Zero is a valid quantity and means "out of stock", not
"unknown". There is no upper bound beyond what a JSON number can hold exactly.

### 3.4 Tags

Tags group items for filtering. A tag is a string; the server lowercases it, trims it, and
drops it if nothing is left. The list stored for an item has no duplicates and is sorted
alphabetically, whatever order or casing the client sent, so `["Office", "paper", "office"]`
is stored as `["office", "paper"]`. This normalization is applied every time a tag list is
accepted, whether the list arrives with a new item, with an import, or as the replacement
list in a partial update. A missing tag list on creation means an item with no tags.

### 3.5 Timestamps

`updatedAt` is an ISO 8601 timestamp in UTC with millisecond precision, as produced by
JavaScript's `Date.prototype.toISOString`. The server sets it when an item is created and
sets it again, to the current time, every time a change to the item succeeds. A client never
sends it; it is a read-only field and the server is the only clock that matters.

## 4. Validation

Validation happens before anything is written. Each field has one validator, described in
section 3, and every endpoint that accepts that field uses the same validator, so the same
bad value produces the same error code no matter how it reached the server. Request bodies
must be JSON objects; a body that does not parse, or that parses to something other than an
object, is answered with `invalid_json` before any field is looked at.

The service is strict about field names in the requests that change an existing item. A
partial update may only mention the fields a client is allowed to change, and anything else
is refused with `unknown_field`, including the read-only fields `id` and `updatedAt`. The
point is to catch typos such as `quantity` early, instead of silently ignoring them and
letting the tablet believe a count was saved.

## 5. Errors

Every error response carries a JSON body of the form `{"error": {"code", "message"}}`. The
code is a stable, machine-readable string from the table in API.md; the message is English
text meant for logs and may change between versions. Clients branch on the code only.

Validation errors use status 400, and a request that fails validation leaves the store
exactly as it was: no field of the item is changed, its timestamp is not touched, and no
item is created. This holds even when a request carries several fields and only the last one
is wrong, so implementations must check everything before they apply anything. A request
that names an item that does not exist is answered with 404 and the code `not_found`; the
same code is used for paths the service does not serve at all.

Unexpected failures inside the server use status 500 with the code `internal`. They are bugs
by definition and the message never includes stack traces or internal paths.

## 6. Listing and filtering

`GET /items` returns every item in a `{"items": [...]}` envelope, ordered as described in
section 3.1. The ordering script needs only part of the list, so the listing accepts an
optional `tag` query parameter. When it is present, the response holds only the items that
carry that tag, matched without regard to case, so `?tag=Office` and `?tag=office` return
the same items. The parameter may name several tags separated by commas, as in
`?tag=office,paper`, and then an item is included only when it carries all of the named
tags; it is a narrowing filter, never a union. Whitespace around each name is ignored.

Filtering for a tag that no item carries is not an error. The answer is a normal 200 with
an empty `items` array, because "nothing in stock with that tag" is a legitimate answer for
the ordering script. Without the parameter the listing behaves exactly as it always has.
The filtered list keeps the numeric id order of the full list.

## 7. Partial updates

`PATCH /items/:id` changes some fields of one existing item and leaves the others alone. The
body is a JSON object holding any subset of `name`, `qty` and `tags`, and each field present
is validated by the rule in section 3: a blank name is `invalid_name`, a quantity that is
not a non-negative integer is `invalid_qty`, and a tag list is normalized exactly as on
creation and replaces the old list as a whole. The tablet sends only the fields the user
touched, which is why every field is optional on its own.

At least one field must be present, though. A body of `{}` changes nothing and almost always
means the client lost its form state, so it is refused with `empty_patch`. Fields outside
the three listed above are refused with `unknown_field`, as section 4 explains. If the id in
the path matches no item the answer is 404 `not_found`.

When the update succeeds the server answers 200 with the full item as it now stands, all
five fields, so that the tablet can redraw the row without a second request. The item's
`updatedAt` reflects the moment of the update. A failed update follows section 5 and leaves
the item untouched.

## 8. Bulk import

`POST /items/bulk` creates many items in one request, for the ordering script's supplier
imports. The body is a JSON object with one field, `items`, whose value is an array of
objects shaped like the body of `POST /items`. An empty array is accepted and creates
nothing. A body without an `items` array is refused with `invalid_item`.

A single request may carry at most one hundred items; a batch of exactly one hundred is
fine, and anything longer is refused with `batch_too_large`. That check is made before any
entry is looked at, so an oversized batch is cheap to refuse. Every entry is validated with
the same rules as a single creation; if any entry fails, the whole request is refused with
`invalid_item`, and the message names the index of the offending entry.

Unlike single creation, an import must not introduce a name that already exists. Names are
compared after trimming and without regard to case, and a clash is refused with
`duplicate_name`, whether the clashing name belongs to an item already in the store or to
another entry earlier in the same batch. Supplier catalogues repeat themselves often, and
two "Bolt M6" rows from one file are as wrong as one that collides with the shelf. Apart
from the size check, the order in which the checks run is not part of the contract.

The import is atomic. Either every entry is created, or none is: when the request is
refused for any reason, the store is left exactly as it was before the request, even if the
offending entry was the last one. On success the answer is 201 with a body of the form
`{"created": [...]}`, holding the new items in the same order as the request, each with its
assigned id and timestamp. Ids are assigned in request order.

## 9. Operations notes

The server listens on the port written in `config/port`, a file local to each checkout that
is not committed; it holds a single number. `scripts/start.sh` starts the server in the
background from the repository root and writes its output to `server.log`. The script does
not keep track of the process it started, so stopping the server is left to whoever started
it, and on a shared machine it is polite to stop it as soon as you are done with it.

The store lives in memory, so restarting the server resets it to `data/items.json`. That is
intended: the seed file is the source of truth for demos and tests, and changes made through
the API are expected to be replayed by the clients that own them. Logs are plain text, one
line per event, and the only line the server writes on a healthy start is `listening on`
followed by the port number.

`GET /health` answers `{"status": "ok"}` as long as the process is able to serve requests.
It does not look at the store and it never fails for reasons that a restart would not fix,
so monitoring should treat a missing or slow answer as the only signal. The ordering script
calls it before an import and gives up for the night if it does not answer within a second,
which is why the endpoint must stay cheap: no logging, no allocation beyond the response.

## 10. Versioning and compatibility

The version in the changelog follows the usual three numbers. Adding an endpoint, a query
parameter, or an error code that only new requests can trigger is a minor change. Changing
the meaning of an existing code, removing a field from a response, or accepting a value that
used to be refused is a major change and needs both clients to agree first. A client that
receives an error code it does not know must treat it as a generic failure of the request,
never as success, so that new codes can be introduced without breaking older clients.

## 11. Non-goals

The service does not authenticate callers, rate-limit them, paginate listings, or persist
anything to disk. It does not support deleting items over HTTP, renaming tags globally, or
searching names. Each of these has been requested at least once and declined, because the
workshop has fewer than five hundred items and two clients, and the cost of the extra rules
would be borne by every future change to the service.

## 12. Glossary

- **Item**: one row of stock, with the five fields described in section 3.
- **Tag**: a lowercase label used to group items for filtering; an item may carry several.
- **Batch**: the array of entries sent to the bulk import endpoint in one request.
- **Entry**: one element of a batch, shaped like the body of a single creation request.
- **Seed file**: `data/items.json`, the items the store holds when the process starts.
- **Narrowing filter**: a filter where each additional term can only remove results.
- **Atomic**: a request whose effects are applied in full or not at all, never partially.
