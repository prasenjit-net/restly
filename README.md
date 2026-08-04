# Restly

Restly is a no-configuration JSON document store. It runs as one Rust binary,
persists data on the local filesystem, exposes convention-based REST resources
under `/data/**`, and includes an embedded admin UI for monitoring, editing,
and exercising the API.

No collection definitions are required. A collection is created the first time
a document is written to it and is removed when it no longer contains any
documents or populated nested collections.

## Quick start

```sh
cd ui && npm install && npm run build && cd ..
cargo run --release
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080). Restly creates a local
`data/` directory beside the binary's working directory when the first
document is stored. That directory is intentionally ignored by Git.

During development, run `cargo run` on port 8080 and `cd ui && npm run dev`
on port 5173. The Vite server proxies `/api`, `/data`, and `/ws`.

## Data API

All application documents live under `/data`. `/api/**` is reserved for
Restly's monitoring and admin APIs, while `/` serves the admin UI.

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/data` | List discovered collections |
| GET | `/data/{collection}` | Find documents |
| POST | `/data/{collection}` | Insert a document |
| GET | `/data/{collection}/{id}` | Find one document |
| PUT | `/data/{collection}/{id}` | Replace or upsert a document |
| PATCH | `/data/{collection}/{id}` | Apply a JSON merge patch |
| DELETE | `/data/{collection}/{id}` | Delete a document |
| GET/POST | `/data/{collection}/{id}/{sub_collection}` | Nested collection operations |

For example:

```sh
curl -X POST http://127.0.0.1:8080/data/users \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","active":true,"profile":{"level":4}}'

curl 'http://127.0.0.1:8080/data/users?where.active=true&sort=-_updatedAt&limit=25'

curl -X PUT http://127.0.0.1:8080/data/users/ada \
  -H 'content-type: application/json' \
  -d '{"name":"Ada Lovelace"}'

curl -X POST http://127.0.0.1:8080/data/users/ada/orders \
  -H 'content-type: application/json' \
  -d '{"total":32,"currency":"GBP"}'
```

Documents must be JSON objects. Restly supplies `_id`, `_createdAt`, and
`_updatedAt`; nested documents also receive `_parent`. Fields beginning with
`_` are reserved.

### Querying

`GET /data/{collection}` accepts these query parameters:

| Parameter | Example | Meaning |
| --- | --- | --- |
| `limit` | `limit=50` | Results per page, 1-1000, default 50 |
| `cursor` | `cursor=d_...` | Continue after the returned `nextCursor` |
| `sort` | `sort=-createdAt,name` | Comma-separated fields; `-` is descending |
| `where.{field}` | `where.active=true` | Exact match; dot paths are supported |
| `where.{field}.{op}` | `where.price.gte=10` | `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`, `prefix`, `exists` |

List responses contain `{ data, page, total }`. Every scalar document field,
including nested scalar fields, is automatically indexed in memory for exact
matches. Indexes are rebuilt from local data when a collection is loaded, so
they never need configuration or separate index files.

## Storage

Collections are stored below `data/collections/` in directories that mirror
their resource path. Writes are appended to a JSONL write-ahead journal and
flushed before the in-memory state changes. After 100 changes, Restly writes a
compact `snapshot.json` and clears that journal. On startup, Restly rebuilds a
collection from its snapshot and journal, recovering committed writes without
an external database. Empty collection directories are pruned automatically;
writing a document to that path later recreates the collection.

## Admin API and UI

The embedded UI has a dashboard, Finder-style collection/document editor, a
request workspace, and an observability console. The request workspace keeps
saved requests, variables, local run history, assertions, and response views
in the browser. The observability console shows the latest 500 server requests
without recording query strings or request bodies. Its supporting endpoints
stay outside the data namespace:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Server liveness and version |
| GET | `/api/config` | UI bootstrap configuration |
| GET | `/api/metrics` | Request, connection, and uptime metrics |
| GET | `/api/requests?limit=100` | Recent method, path, status, duration, and timestamp traces |
| GET | `/api/stats` | Collection/document totals and data directory |
| GET | `/api/collections` | Collection names, counts, and automatic indexes |
| POST | `/api/maintenance/compact` | Compact all loaded collections |
| GET | `/ws` | Live metrics and document activity |

Errors use a consistent JSON envelope:

```json
{ "error": { "code": "NOT_FOUND", "message": "document x does not exist", "status": 404 } }
```

## Configuration

`config.toml` controls only server, logging, and UI presentation settings.
It is not used to declare schemas, collections, indexes, or routes. CLI flags
can override the host, port, logging level, access-log path, and config path.

## Verification

```sh
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test
cd ui && npm test && npm run build
```

## Postman Demo

Import [Restly.postman_collection.json](postman/Restly.postman_collection.json) into Postman and run the requests in order. It uses a unique `postman-demo-*` collection for each run, validates the main REST API workflows, and removes its demo documents and collection during cleanup.
