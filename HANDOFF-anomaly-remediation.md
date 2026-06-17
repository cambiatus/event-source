# Handoff: find & fix all stranded-join / duplicate-token anomalies (prod data)

## Why this exists

event-source had two data-integrity bugs (now **fixed in code** — see "What changed" below). Before the fix landed, they ran in prod for an unknown period, so an unknown number of accounts/rows are in a bad state. This prompt is for an operator to **find every affected case and remediate it manually**. `maysalex1234` / `0,MUDA` is the one confirmed case; expect several more.

You will be working against **prod Postgres** and (optionally) the **EOS history node**. Treat every query as read-only until you have reviewed the counts and are explicitly running a remediation block inside a transaction.

## The two bugs (root cause, so you can reason about the data)

1. **Silent dropped membership.** The `netlink` updater (community join) wrote `users`, `network`, `network_roles` and **caught its own errors** (`logError` then returned normally). Each on-chain join tx also carries a welcome `cambiatus.tk::issue` (mint) + `cambiatus.tk::transfer`. All actions of one tx run inside a single serializable DB transaction. Because `netlink` swallowed its error, demux saw success and **committed the welcome mint/transfer while the `network` row was missing** → user is joined on-chain but has no membership row → backend `community_member?` fails; if the community has `auto_invite = false`, sign-in is refused.

   - Variant: a join could also insert the `network` row but then throw while assigning the `member` role (old code threw *after* the network insert). That yields a **`network` row with no `network_roles` entry** ("roleless membership"). Check for this class too.

2. **Duplicate mints/transfers.** `issue`/`transfer` did bare `.insert(...)` with no idempotency. Every re-index pass (microfork / restart / manual reindex) appended another copy. `maysalex1234` had **8 welcome mints + 4 welcome transfers** from 4 reindex passes. Wherever bug #1 kept failing, each manual reindex re-appended the welcome rows → the duplicate count is roughly `(number of reindex passes)` and is a strong fingerprint of a stranded join.

## What changed in code (so remediation matches new behavior)

- `netlink` (`src/updaters/community.js`): no longer swallows errors (a failed join now rolls back the whole block and is retried); `users` + `network` inserts use `INSERT ... ON CONFLICT DO NOTHING`; `network` insert uses `RETURNING id` and only assigns the `member` role when a new row was actually inserted. Idempotent + atomic.
- `transfer` / `issue` (`src/updaters/token.js`): dedup guard (skip if a row with the same `created_tx, from_id/to_id, community_id, created_block` already exists) before insert. Prevents *new* duplicates; does **not** remove existing ones.

Implication for you: **re-indexing an affected block against the fixed code will self-heal a stranded join** (insert the missing `network` + role, skip duplicate mint/transfer). It will **not** delete pre-existing duplicate rows — those need a one-time dedup. See "Remediation options".

## STEP 0 — verify schema before running anything

The detection/remediation SQL below uses column names inferred from the updater insert code. **Confirm them first**, names may differ:

```sql
\d network
\d network_roles
\d roles
\d users
\d transfers
\d mints
```

Confirm in particular:
- `network` columns: `community_id, account_id, invited_by_id, created_block, created_tx, created_eos_account, created_at` (+ `id`).
- the unique index on `network (account_id, community_id)` exists (the code's `ON CONFLICT` relies on it; if missing, the backend must add it via migration).
- `network_roles (network_id, role_id, inserted_at, updated_at)`.
- `roles (id, community_id, name, ...)` with a `member` row per community.
- `transfers (id, from_id, to_id, amount, community_id, memo, created_block, created_tx, created_at, ...)`.
- `mints (id, to_id, quantity, community_id, memo, created_block, created_tx, created_at, ...)`.

If a column name differs (e.g. `to_account` vs `to_id`), fix the queries accordingly.

## STEP 1 — detection (read-only)

### 1a. Stranded joins — welcome mint recipients with no membership row
The welcome mint/transfer memo is `Welcome to <community name>!`. The recipient must have a `network` row in that community; if not, it's a stranded join.

```sql
-- All communities: accounts that received a welcome MINT but have no network row in that community
SELECT m.community_id, m.to_id AS account, count(*) AS welcome_mint_copies,
       min(m.created_block) AS join_block, min(m.created_tx) AS join_tx
FROM mints m
WHERE m.memo ILIKE 'Welcome to %'
  AND NOT EXISTS (
    SELECT 1 FROM network n
    WHERE n.account_id = m.to_id AND n.community_id = m.community_id
  )
GROUP BY m.community_id, m.to_id
ORDER BY welcome_mint_copies DESC;
```

```sql
-- Same, via welcome TRANSFER (covers communities where the join welcome is a transfer, not a mint)
SELECT t.community_id, t.to_id AS account, count(*) AS welcome_transfer_copies,
       min(t.created_block) AS join_block, min(t.created_tx) AS join_tx
FROM transfers t
WHERE t.memo ILIKE 'Welcome to %'
  AND NOT EXISTS (
    SELECT 1 FROM network n
    WHERE n.account_id = t.to_id AND n.community_id = t.community_id
  )
GROUP BY t.community_id, t.to_id
ORDER BY welcome_transfer_copies DESC;
```

> Note: `welcome_*_copies > 1` is itself the duplicate fingerprint (bug #2). `join_block` / `join_tx` give you the block to re-index or the tx metadata to backfill from.

### 1b. Roleless memberships — network row with no role
```sql
SELECT n.id AS network_id, n.community_id, n.account_id
FROM network n
WHERE NOT EXISTS (SELECT 1 FROM network_roles nr WHERE nr.network_id = n.id)
ORDER BY n.community_id, n.account_id;
```

### 1c. Duplicate mints / transfers (dedup targets)
```sql
-- Duplicate mints by the idempotency key the code now uses
SELECT created_tx, to_id, community_id, created_block, count(*) AS copies
FROM mints
GROUP BY created_tx, to_id, community_id, created_block
HAVING count(*) > 1
ORDER BY copies DESC, created_tx;

-- Duplicate transfers by the same key (+ from_id)
SELECT created_tx, from_id, to_id, community_id, created_block, count(*) AS copies
FROM transfers
GROUP BY created_tx, from_id, to_id, community_id, created_block
HAVING count(*) > 1
ORDER BY copies DESC, created_tx;
```

> Caveat: this key cannot tell apart two *legitimately identical* transfers within one tx (rare). Eyeball any group where the same `(from_id, to_id, community_id)` could plausibly occur twice in one real tx before deleting.

### 1d. (Optional) confirm on-chain truth
For any account from 1a, confirm the join really happened on-chain (it should — the welcome mint/transfer is itself proof, but to get the exact `inviter`, `created_block`, `created_tx`, `created_at` for the backfill):

```sh
# get_actions for the community contract, then find the netlink action for the account.
# Adjust pos/offset to page through history near the welcome-mint block.
curl -s "<EOS_NODE_URL>/v1/history/get_actions" \
  -d '{"account_name":"cambiatus.cm","pos":-1,"offset":-50}' | jq '.actions[].action_trace.act | select(.name=="netlink")'
```
Use the netlink action's `trx_id`, `block_num`, `block_time`, and `data.inviter` for the backfill.

## STEP 2 — remediation

Pick **one** path per affected account. Path A is preferred because it uses the fixed, idempotent code and reproduces exactly what should have happened.

### Path A — re-index the affected block(s) (preferred)
For each stranded join, take `join_block` from STEP 1a. Run the **fixed** event-source pointed so it reprocesses that block (e.g. set `config.blockchain.initialBlock` to `join_block` in a one-off run, or use the reader's seek). The fixed `netlink` will insert the missing `network` row + `member` role; the fixed `issue`/`transfer` will skip the already-present welcome rows (no new duplicates). Verify with STEP 1a afterward (count should drop to 0 for that account).

- Pros: single code path, correct `invited_by_id`/timestamps, no hand-written SQL.
- Does **not** remove pre-existing duplicate rows — still run Path C dedup.
- Watch for: re-indexing a range also re-runs every other action in those blocks (all idempotent now, but verify on a staging copy first if you can).

### Path B — direct SQL backfill (when you can't re-index)
For one stranded join, inside a transaction. Fill the bracketed values from STEP 1 / STEP 1d.

```sql
BEGIN;

-- 1) membership row
INSERT INTO network (community_id, account_id, invited_by_id, created_block, created_tx, created_eos_account, created_at)
VALUES ('<community_id>', '<account>', '<inviter>', <join_block>, '<join_tx>', '<inviter_or_eos_actor>', '<join_ts>')
ON CONFLICT DO NOTHING
RETURNING id;   -- note the returned network id

-- 2) member role for that network row
INSERT INTO network_roles (network_id, role_id, inserted_at, updated_at)
SELECT n.id, r.id, now(), now()
FROM network n
JOIN roles r ON r.community_id = n.community_id AND r.name = 'member'
WHERE n.account_id = '<account>' AND n.community_id = '<community_id>'
  AND NOT EXISTS (SELECT 1 FROM network_roles nr WHERE nr.network_id = n.id);

-- verify both rows exist, then:
COMMIT;   -- or ROLLBACK if counts look wrong
```

For roleless memberships (STEP 1b), run only block (2) above (it self-targets any network row missing its member role).

### Path C — dedup mints/transfers (one-time)
Keep the lowest `id` per dedup group, delete the rest. **Run the SELECT count first, then the DELETE in a transaction.**

```sql
BEGIN;

-- mints
DELETE FROM mints m
USING (
  SELECT min(id) AS keep_id, created_tx, to_id, community_id, created_block
  FROM mints
  GROUP BY created_tx, to_id, community_id, created_block
  HAVING count(*) > 1
) d
WHERE m.created_tx = d.created_tx AND m.to_id = d.to_id
  AND m.community_id = d.community_id AND m.created_block = d.created_block
  AND m.id <> d.keep_id;

-- transfers
DELETE FROM transfers t
USING (
  SELECT min(id) AS keep_id, created_tx, from_id, to_id, community_id, created_block
  FROM transfers
  GROUP BY created_tx, from_id, to_id, community_id, created_block
  HAVING count(*) > 1
) d
WHERE t.created_tx = d.created_tx AND t.from_id = d.from_id AND t.to_id = d.to_id
  AND t.community_id = d.community_id AND t.created_block = d.created_block
  AND t.id <> d.keep_id;

-- re-run the STEP 1c SELECTs (should return 0 rows), then:
COMMIT;
```

> Check FKs first: if anything references `mints.id` / `transfers.id` (e.g. payment history), deleting the higher-id copies may orphan those references. Inspect `\d mints` / `\d transfers` for inbound FKs, and prefer keeping whichever id is already referenced.

## STEP 3 — verify each fixed account
```sql
-- Should be exactly 1 network row + >=1 member role, 0 duplicate welcome rows
SELECT count(*) FROM network WHERE account_id = '<account>' AND community_id = '<community_id>';   -- 1
SELECT count(*) FROM network_roles nr JOIN network n ON n.id = nr.network_id
  WHERE n.account_id = '<account>' AND n.community_id = '<community_id>';                            -- >=1
```
Then have the affected user attempt sign-in to the community (confirmed-broken case: `maysalex1234` → `0,MUDA`).

## Backend follow-ups (separate repo, separate deploy — not event-source)
- Add a **unique index on `network (account_id, community_id)`** if STEP 0 shows it missing (the event-source `ON CONFLICT` depends on it).
- Consider adding a `(created_tx, action_index)` unique index on `mints`/`transfers` so dedup is enforced at the DB level. event-source already receives `payload.actionIndex` (`account_action_seq`) and can write it once the column exists; until then its dedup is best-effort on existing columns and can't distinguish two identical transfers in one tx.

## Confirmed case (sanity check your queries against this)
- `maysalex1234` / `0,MUDA`: 0 network rows, 8 welcome mints, 4 welcome transfers, join tx `44861a92…`, block `416264578`, ts `2026-06-15 14:26:15`, inviter `adminmuda`, community `auto_invite = false`. After remediation: 1 network row + member role, 1 mint, 1 transfer, sign-in succeeds.
