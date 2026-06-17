# Handoff: event-source silently drops `network` membership rows on community join

## TL;DR

A community join is **one on-chain transaction containing several actions** (`cambiatus.cm::netlink` + `cambiatus.tk::issue` welcome mint + `cambiatus.tk::transfer` welcome transfer). event-source dispatches each action to an **independent updater with no shared DB transaction**, and the `netlink` updater **swallows its own insert errors**. So when the `network` insert fails, the mint/transfer rows still get written, demux is never told netlink failed, the block is committed as success — and the user ends up **joined on-chain but with no `network` membership row**. They can authenticate but can't sign in to the community (backend `community_member?` reads the missing `network` row → tries to auto-join → blocked if `auto_invite=false`).

Separately, the token updaters have **no idempotency**, so re-indexed blocks produce **duplicate** mint/transfer rows.

## Confirmed real case (use as test fixture)

- Account: **`maysalex1234`** (community **`0,MUDA`**)
- `users` row created `2026-06-15 14:26:13`; join tx **`44861a92…`**, block **`416264578`**, ts `2026-06-15 14:26:15` (≈2s after registration)
- DB state (prod, read-only verified):
  - `network` rows for her: **0** (in MUDA and in every community)
  - welcome **mint** rows: present (qty 20, memo "Welcome to MUDA!") — **8 copies**
  - welcome **transfer** rows (`adminmuda → maysalex1234`): present — **4 copies**
  - duplicates were re-emitted across **4 re-index passes** (14:39 / 16:43 / 16:57 / 17:42)
- MUDA `communities.auto_invite = false` → backend refuses to re-add her on signIn ("...don't allow for auto invites, please provide an invitation").

So: she joined (chain + welcome mint/transfer prove it), but the `network` row was never written, and the token rows were duplicated.

## Root cause — code references

Architecture (`src/CLAUDE.md`): `NodeosActionReader` → `BaseActionWatcher` (500ms poll) → `MassiveActionHandler` (demux-postgres) matches each **action** `"contract::action"` to an updater in `src/updaters.js`. **Each action is handled independently; there is no transaction spanning all actions of one on-chain tx.**

1. **No cross-action atomicity.** `src/updaters.js:25-101` registers `cm::netlink`, `tk::issue`, `tk::transfer` as separate updaters. A single join tx fires all three; they are applied as independent writes. Partial failure (netlink fails, issue/transfer succeed) is exactly maysalex's state.

2. **`netlink` swallows errors** — `src/updaters/community.js:142-196`:
   - `src/updaters/community.js:193-195` — the network/role insert is wrapped in `try { … } catch (error) { logError(…) }` that **logs to Sentry and returns normally**. demux therefore sees success → **no retry, no block rollback** → permanent silent inconsistency.
   - `src/updaters/community.js:162-168` — idempotency is a **check-then-insert** (`db.network.count` then insert) with no lock and no use of the unique constraint; racy.
   - `src/updaters/community.js:150,172,192` — `users`, `network`, `network_roles` are **three separate `db.*.insert` calls, not in one transaction**. If `network.insert` (172) throws, nothing rolls back, but also nothing is written; if it succeeded and `network_roles` (192) failed, you'd get a network row with no role. (maysalex has zero network rows → the throw is at/before line 172.)
   - Likely specific throw for her (confirm in Sentry — see below): `db.roles.findOne({name:'member'})` returning null → `throw` at `:183` happens **after** the network insert, so that wouldn't explain a missing network row; the missing row means `db.network.insert` (172) itself threw — candidate causes: `invited_by_id: payload.data.inviter` FK (`:175`) not present in `users`, or a transient DB error during the indexing churn.

3. **Token updaters not idempotent** — `src/updaters/token.js:38-58` (`transfer`) and `:62-78` (`issue`) do a bare `.insert(...)` with no `count`/`findOne`/`onConflict`. Re-indexed blocks (microforks / restarts / manual reindex) insert duplicates → maysalex's 8 mints + 4 transfers. (Same class of duplicate-row bug the frontend `fix/payment-history-duplicates` branch worked around downstream.)

4. **Sentry breadcrumb:** `src/logging.js` `logError` captures to Sentry. The exact failing error for maysalex should be there: message `"Something went wrong while trying to insert user and its role to the network"`, around `2026-06-15 14:26`, tx `44861a92…`. Pull it to confirm the precise throw.

## Fix direction (event-source)

1. **Make each updater's writes atomic.** `netlink` must wrap the `users`/`network`/`network_roles` inserts in `db.withTransaction(...)` (the `createCommunity` updater at `community.js:18-86` already does this — follow that pattern). All-or-nothing.
2. **Stop swallowing errors.** Let `netlink` (and peers) **throw** on failure so `MassiveActionHandler` rolls back / retries the block instead of committing a half-applied join. Swallow == silent data loss.
3. **Idempotency on every updater.** Replace check-then-insert and bare inserts with upserts keyed on natural keys / `(created_tx, action_index)` using `onConflict … ignore`:
   - `network`: rely on the existing unique index `network_account_community_index (account_id, community_id)` — insert with on-conflict-do-nothing instead of `count` (fixes both the race and retry-safety).
   - `transfers` / `mints`: dedup on `created_tx` (+ action index) so reindex passes can't duplicate.
   - Also add the matching `unique_constraint` to the backend Ecto schema `network.ex` so app-side inserts surface clean errors (backend repo note, not event-source).
4. **Reconciliation job / script.** Detect chain↔DB drift: accounts with a welcome mint/transfer (or an on-chain `netlink`) but **no `network` row**, and backfill membership. Run it after deploying the fix.

## Verification / repro SQL (read-only)

```sql
-- Repro: she has welcome mint/transfer but no network row
SELECT 'network'  src, count(*) FROM network   WHERE account_id = 'maysalex1234';            -- expect 0 (bug)
SELECT 'transfer' src, count(*) FROM transfers  WHERE to_account = 'maysalex1234' AND community_id = '0,MUDA';  -- >0
SELECT 'mint'     src, count(*) FROM mints       WHERE "to" = 'maysalex1234'      AND community_id = '0,MUDA';  -- >0
-- (verify exact column names with \d transfers / \d mints / \d network first)

-- Stranded cohort: welcome-transfer recipients in MUDA with no network row
SELECT DISTINCT t.to_account
FROM transfers t
WHERE t.community_id = '0,MUDA'
  AND t.memo ILIKE 'Welcome to %'
  AND NOT EXISTS (
    SELECT 1 FROM network n
    WHERE n.account_id = t.to_account AND n.community_id = '0,MUDA'
  );

-- Duplicate detection (idempotency regression guard): transfers with same tx appearing >1x
SELECT created_tx, count(*) FROM transfers GROUP BY created_tx HAVING count(*) > 1 ORDER BY 2 DESC LIMIT 20;
```

## Remediation (data, separate from the code fix)

- **Unblock maysalex now:** backfill her membership — insert one `network` row (`account_id=maysalex1234`, `community_id=0,MUDA`, `invited_by_id=adminmuda`, `created_block=416264578`, `created_tx=44861a92…`, `created_at=2026-06-15 14:26:15`) + the `network_roles` `member` row — **or** replay `netlink` for tx `44861a92…` after the code fix lands.
- **Cohort:** run the stranded-cohort query above and backfill the set.
- **Dedup:** the duplicate mint/transfer rows are downstream noise; dedup once idempotency is in place.

## Acceptance test

1. Re-index block `416264578` against fixed event-source → exactly **one** `network` row for `maysalex1234`, **no** new duplicate mint/transfer rows.
2. A forced failure in `netlink` (e.g. temporary FK break) → block is **retried**, not silently committed; no half-applied join.
3. `maysalex1234` signIn to MUDA succeeds.
