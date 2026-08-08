// Every timestamp column we write is `timestamp without time zone` (matching the Elixir
// backend, which stores UTC via DateTime.utc_now()). Handing a JS Date to node-pg (or to
// pg-promise, which reuses pg's serializer) formats it in the process's LOCAL zone and
// appends an offset that Postgres then IGNORES for tz-less columns — so a raw Date lands
// as host-local wall clock (seen live: block 2026-08-04T21:04:09Z stored as 23:04:09 on
// a CEST host). Format every Date we write as an explicit UTC ISO string instead;
// Postgres parses it and stores the true UTC instant regardless of the indexer's TZ.
function toUTC (date) {
  return date.toISOString()
}

module.exports = { toUTC }
