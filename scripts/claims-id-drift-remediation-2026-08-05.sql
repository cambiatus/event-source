-- ============================================================================
-- Claims id ↔ chain id drift remediation, round 2 (drift of 2026-07-02 → 2026-08-05)
-- ----------------------------------------------------------------------------
-- DO NOT RUN unattended. Review, run the pre-flight SELECTs, then execute inside
-- the transaction and COMMIT only if every "expect" check matches. Lucca runs this.
--
-- Root cause (fixed in event-source PR "stop claim-id serial drift"):
-- get_table_rows on nodeos v2.0.7 reports `more: true` for a bounded
-- secondary-index query whenever ANY row with a higher key exists (verified
-- 2026-08-05: claim query bounded to action 389 returned only that action's
-- 22 rows, with more:true). chain.js treated `more` as truncation and threw;
-- claimAction caught the throw and inserted with the DB serial ("falling back
-- to serial"), so EVERY claim created while that code ran got a serial id
-- instead of its chain id.
--
-- Drift analysis (prod DB vs chain, both read 2026-08-05):
--   * claims total 19,960, max(id) 19,980; chain claim counter at 19,982.
--   * ids <= 19866 still aligned (round-1 reconciliation held).
--   * 114 claims with id >= 19867: 55 aligned, 59 DRIFTED (mapping below,
--     built with the exact rule resolveClaimId uses: within each
--     (action_id, claimer_id) pair, the nth DB row by id is the nth chain
--     claim by id). Late drift converges to a constant +2 (db 19953 -> chain
--     19955, db 19980 -> chain 19982).
--   * The +2 comes from TWO chain claims that have NO DB row at all:
--       chain 19871 = action 292 / welovecircus (approved on chain)
--       chain 19904 = action 123 / bananadacult (approved on chain)
--     Both are second claims made seconds after a first -- consistent with two
--     claimactions batched in ONE transaction being collapsed by the
--     (created_tx, action_id, claimer_id) dedup guard. Handled in step 4 below.
--   * checks / notification_history follow claims.id via FK (NOT deferrable),
--     so the FKs are dropped and re-added inside the transaction. The checks
--     on a drifted row were cast in the app against THAT row (user intent),
--     so they must move with it.
--
-- Out of scope (chain state, flagged for follow-up): while drifted, on-chain
-- verifyclaim(db_id) votes landed on the WRONG chain claims, so chain-side
-- claim statuses (and any rewards/mints they triggered) diverge from user
-- intent for claims in the 19867-19982 chain-id range. DB statuses kept below
-- are the user-intent ones (recomputed from DB checks by verifyClaim). Chain
-- state needs a separate, manual review -- it cannot be fixed from SQL.
-- ============================================================================

-- ----- pre-flight (run first; all counts must match) ------------------------
-- expect 59:
SELECT count(*) AS drifted_rows FROM claims WHERE id IN (19871, 19890, 19904, 19907, 19915, 19917, 19922, 19924, 19925, 19926, 19927, 19929, 19930, 19932, 19933, 19935, 19937, 19938, 19939, 19940, 19941, 19942, 19943, 19944, 19945, 19946, 19947, 19948, 19949, 19951, 19952, 19953, 19954, 19955, 19956, 19957, 19958, 19959, 19960, 19961, 19962, 19963, 19964, 19965, 19966, 19967, 19968, 19969, 19970, 19971, 19972, 19973, 19974, 19975, 19976, 19977, 19978, 19979, 19980);
-- expect 0 (every drifted row still has the identity the mapping assumes):
WITH m(old_id, new_id, action_id, claimer_id) AS (VALUES
  (19871, 19890, 313, 'thaisinhar41'),
  (19890, 19907, 114, 'aletrapino12'),
  (19904, 19917, 312, 'anabravos222'),
  (19907, 19915, 390, 'thaisinhar41'),
  (19915, 19922, 390, 'thaisinhar41'),
  (19917, 19924, 115, 'queenmaridun'),
  (19922, 19925, 390, 'thaisinhar41'),
  (19924, 19926, 390, 'thaisinhar41'),
  (19925, 19927, 123, 'solaldanax11'),
  (19926, 19929, 114, 'marques12345'),
  (19927, 19930, 115, 'marques12345'),
  (19929, 19932, 390, 'thaisinhar41'),
  (19930, 19933, 310, 'thaisinhar41'),
  (19932, 19935, 114, 'valentim1234'),
  (19933, 19937, 312, 'mhfrocaille1'),
  (19935, 19938, 312, 'mhfrocaille1'),
  (19937, 19939, 313, 'mhfrocaille1'),
  (19938, 19940, 112, 'fernandagab2'),
  (19939, 19941, 112, 'fernandagab2'),
  (19940, 19942, 312, 'fernandagab2'),
  (19941, 19943, 312, 'fernandagab2'),
  (19942, 19944, 388, 'fernandagab2'),
  (19943, 19945, 388, 'fernandagab2'),
  (19944, 19946, 312, 'fernandagab2'),
  (19945, 19947, 312, 'fernandagab2'),
  (19946, 19948, 312, 'azizicyprian'),
  (19947, 19949, 389, 'cacocachagas'),
  (19948, 19951, 312, 'analismoreno'),
  (19949, 19952, 390, 'thaisinhar41'),
  (19951, 19953, 390, 'thaisinhar41'),
  (19952, 19954, 312, 'thaisinhar41'),
  (19953, 19955, 390, 'thaisinhar41'),
  (19954, 19956, 311, 'anabravos222'),
  (19955, 19957, 310, 'anabravos222'),
  (19956, 19958, 389, 'fernandagab2'),
  (19957, 19959, 310, 'fernandagab2'),
  (19958, 19960, 114, 'livroseafins'),
  (19959, 19961, 310, 'azulimaoazul'),
  (19960, 19962, 309, 'azulimaoazul'),
  (19961, 19963, 309, 'azulimaoazul'),
  (19962, 19964, 309, 'azulimaoazul'),
  (19963, 19965, 309, 'azulimaoazul'),
  (19964, 19966, 388, 'fernandagab2'),
  (19965, 19967, 112, 'ceciliabelem'),
  (19966, 19968, 390, 'discodorado2'),
  (19967, 19969, 312, 'discodorado2'),
  (19968, 19970, 390, 'thaisinhar41'),
  (19969, 19971, 112, 'fernandagab2'),
  (19970, 19972, 112, 'fernandagab2'),
  (19971, 19973, 390, 'thaisinhar41'),
  (19972, 19974, 114, 'gabrielaslol'),
  (19973, 19975, 115, 'gabrielaslol'),
  (19974, 19976, 312, 'mhfrocaille1'),
  (19975, 19977, 310, 'mhfrocaille1'),
  (19976, 19978, 292, 'helenamaltez'),
  (19977, 19979, 309, 'discodorado2'),
  (19978, 19980, 115, 'thalesmelo11'),
  (19979, 19981, 313, 'naracampos12'),
  (19980, 19982, 389, 'matteoa12345')
)
SELECT count(*) AS identity_mismatches
FROM claims c JOIN m ON c.id = m.old_id
WHERE c.action_id <> m.action_id OR c.claimer_id <> m.claimer_id;
-- expect 0 (no target id is held by a row that is NOT itself being renumbered):
WITH m(old_id, new_id, action_id, claimer_id) AS (VALUES
  (19871, 19890, 313, 'thaisinhar41'),
  (19890, 19907, 114, 'aletrapino12'),
  (19904, 19917, 312, 'anabravos222'),
  (19907, 19915, 390, 'thaisinhar41'),
  (19915, 19922, 390, 'thaisinhar41'),
  (19917, 19924, 115, 'queenmaridun'),
  (19922, 19925, 390, 'thaisinhar41'),
  (19924, 19926, 390, 'thaisinhar41'),
  (19925, 19927, 123, 'solaldanax11'),
  (19926, 19929, 114, 'marques12345'),
  (19927, 19930, 115, 'marques12345'),
  (19929, 19932, 390, 'thaisinhar41'),
  (19930, 19933, 310, 'thaisinhar41'),
  (19932, 19935, 114, 'valentim1234'),
  (19933, 19937, 312, 'mhfrocaille1'),
  (19935, 19938, 312, 'mhfrocaille1'),
  (19937, 19939, 313, 'mhfrocaille1'),
  (19938, 19940, 112, 'fernandagab2'),
  (19939, 19941, 112, 'fernandagab2'),
  (19940, 19942, 312, 'fernandagab2'),
  (19941, 19943, 312, 'fernandagab2'),
  (19942, 19944, 388, 'fernandagab2'),
  (19943, 19945, 388, 'fernandagab2'),
  (19944, 19946, 312, 'fernandagab2'),
  (19945, 19947, 312, 'fernandagab2'),
  (19946, 19948, 312, 'azizicyprian'),
  (19947, 19949, 389, 'cacocachagas'),
  (19948, 19951, 312, 'analismoreno'),
  (19949, 19952, 390, 'thaisinhar41'),
  (19951, 19953, 390, 'thaisinhar41'),
  (19952, 19954, 312, 'thaisinhar41'),
  (19953, 19955, 390, 'thaisinhar41'),
  (19954, 19956, 311, 'anabravos222'),
  (19955, 19957, 310, 'anabravos222'),
  (19956, 19958, 389, 'fernandagab2'),
  (19957, 19959, 310, 'fernandagab2'),
  (19958, 19960, 114, 'livroseafins'),
  (19959, 19961, 310, 'azulimaoazul'),
  (19960, 19962, 309, 'azulimaoazul'),
  (19961, 19963, 309, 'azulimaoazul'),
  (19962, 19964, 309, 'azulimaoazul'),
  (19963, 19965, 309, 'azulimaoazul'),
  (19964, 19966, 388, 'fernandagab2'),
  (19965, 19967, 112, 'ceciliabelem'),
  (19966, 19968, 390, 'discodorado2'),
  (19967, 19969, 312, 'discodorado2'),
  (19968, 19970, 390, 'thaisinhar41'),
  (19969, 19971, 112, 'fernandagab2'),
  (19970, 19972, 112, 'fernandagab2'),
  (19971, 19973, 390, 'thaisinhar41'),
  (19972, 19974, 114, 'gabrielaslol'),
  (19973, 19975, 115, 'gabrielaslol'),
  (19974, 19976, 312, 'mhfrocaille1'),
  (19975, 19977, 310, 'mhfrocaille1'),
  (19976, 19978, 292, 'helenamaltez'),
  (19977, 19979, 309, 'discodorado2'),
  (19978, 19980, 115, 'thalesmelo11'),
  (19979, 19981, 313, 'naracampos12'),
  (19980, 19982, 389, 'matteoa12345')
)
SELECT count(*) AS blocking_targets
FROM claims c JOIN m ON c.id = m.new_id
WHERE c.id NOT IN (SELECT old_id FROM m);
-- expect 0 (the two chain-missing claims really are absent):
SELECT count(*) AS should_be_zero FROM claims
WHERE (action_id = 292 AND claimer_id = 'welovecircus' AND id <> 19870)
   OR (action_id = 123 AND claimer_id = 'bananadacult' AND id <> 19903);

-- ----- remediation ----------------------------------------------------------
BEGIN;

CREATE TEMP TABLE _claim_id_map
  (old_id bigint PRIMARY KEY, new_id bigint UNIQUE, action_id bigint, claimer_id text);
INSERT INTO _claim_id_map VALUES
  (19871, 19890, 313, 'thaisinhar41'),
  (19890, 19907, 114, 'aletrapino12'),
  (19904, 19917, 312, 'anabravos222'),
  (19907, 19915, 390, 'thaisinhar41'),
  (19915, 19922, 390, 'thaisinhar41'),
  (19917, 19924, 115, 'queenmaridun'),
  (19922, 19925, 390, 'thaisinhar41'),
  (19924, 19926, 390, 'thaisinhar41'),
  (19925, 19927, 123, 'solaldanax11'),
  (19926, 19929, 114, 'marques12345'),
  (19927, 19930, 115, 'marques12345'),
  (19929, 19932, 390, 'thaisinhar41'),
  (19930, 19933, 310, 'thaisinhar41'),
  (19932, 19935, 114, 'valentim1234'),
  (19933, 19937, 312, 'mhfrocaille1'),
  (19935, 19938, 312, 'mhfrocaille1'),
  (19937, 19939, 313, 'mhfrocaille1'),
  (19938, 19940, 112, 'fernandagab2'),
  (19939, 19941, 112, 'fernandagab2'),
  (19940, 19942, 312, 'fernandagab2'),
  (19941, 19943, 312, 'fernandagab2'),
  (19942, 19944, 388, 'fernandagab2'),
  (19943, 19945, 388, 'fernandagab2'),
  (19944, 19946, 312, 'fernandagab2'),
  (19945, 19947, 312, 'fernandagab2'),
  (19946, 19948, 312, 'azizicyprian'),
  (19947, 19949, 389, 'cacocachagas'),
  (19948, 19951, 312, 'analismoreno'),
  (19949, 19952, 390, 'thaisinhar41'),
  (19951, 19953, 390, 'thaisinhar41'),
  (19952, 19954, 312, 'thaisinhar41'),
  (19953, 19955, 390, 'thaisinhar41'),
  (19954, 19956, 311, 'anabravos222'),
  (19955, 19957, 310, 'anabravos222'),
  (19956, 19958, 389, 'fernandagab2'),
  (19957, 19959, 310, 'fernandagab2'),
  (19958, 19960, 114, 'livroseafins'),
  (19959, 19961, 310, 'azulimaoazul'),
  (19960, 19962, 309, 'azulimaoazul'),
  (19961, 19963, 309, 'azulimaoazul'),
  (19962, 19964, 309, 'azulimaoazul'),
  (19963, 19965, 309, 'azulimaoazul'),
  (19964, 19966, 388, 'fernandagab2'),
  (19965, 19967, 112, 'ceciliabelem'),
  (19966, 19968, 390, 'discodorado2'),
  (19967, 19969, 312, 'discodorado2'),
  (19968, 19970, 390, 'thaisinhar41'),
  (19969, 19971, 112, 'fernandagab2'),
  (19970, 19972, 112, 'fernandagab2'),
  (19971, 19973, 390, 'thaisinhar41'),
  (19972, 19974, 114, 'gabrielaslol'),
  (19973, 19975, 115, 'gabrielaslol'),
  (19974, 19976, 312, 'mhfrocaille1'),
  (19975, 19977, 310, 'mhfrocaille1'),
  (19976, 19978, 292, 'helenamaltez'),
  (19977, 19979, 309, 'discodorado2'),
  (19978, 19980, 115, 'thalesmelo11'),
  (19979, 19981, 313, 'naracampos12'),
  (19980, 19982, 389, 'matteoa12345');

-- FKs are NOT deferrable, so drop them for the renumber and re-add after.
ALTER TABLE checks DROP CONSTRAINT checks_claim_id_fkey;
ALTER TABLE notification_history DROP CONSTRAINT notification_history_claim_id_fkey;

-- phase 1: shift parents and children out of the target range together
UPDATE claims c SET id = c.id + 1000000 FROM _claim_id_map m WHERE c.id = m.old_id;
UPDATE checks k SET claim_id = k.claim_id + 1000000 FROM _claim_id_map m WHERE k.claim_id = m.old_id;
UPDATE notification_history n SET claim_id = n.claim_id + 1000000 FROM _claim_id_map m WHERE n.claim_id = m.old_id;

-- phase 2: assign the real chain ids
UPDATE claims c SET id = m.new_id FROM _claim_id_map m WHERE c.id = m.old_id + 1000000;
UPDATE checks k SET claim_id = m.new_id FROM _claim_id_map m WHERE k.claim_id = m.old_id + 1000000;
UPDATE notification_history n SET claim_id = m.new_id FROM _claim_id_map m WHERE n.claim_id = m.old_id + 1000000;

ALTER TABLE checks ADD CONSTRAINT checks_claim_id_fkey
  FOREIGN KEY (claim_id) REFERENCES claims(id);
ALTER TABLE notification_history ADD CONSTRAINT notification_history_claim_id_fkey
  FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE;

-- step 4: the two chain claims with no DB row (see header). Chain-verified data
-- (get_table_rows claim 19871 / 19904, 2026-08-05). created_tx/created_block are
-- unknown from table data -- left NULL (columns nullable; the dedup index treats
-- NULLs as distinct). Status is the CHAIN status; checks these claims received
-- on chain were recorded in the DB against the rows that held ids 19871/19904
-- at the time (user-intent side), so they are NOT re-created here.
INSERT INTO claims (id, action_id, claimer_id, status, proof_photo, proof_code, created_at)
VALUES
  (19871, 292, 'welovecircus', 'approved',
   'https://cambiatus-uploads.s3.amazonaws.com/cambiatus-uploads/2d1f6867e8ac4e00ae46ff5a9f3c8a88', '', now()),
  (19904, 123, 'bananadacult', 'approved',
   'https://cambiatus-uploads.s3.amazonaws.com/cambiatus-uploads/78570de9981c408cb33a7e5d256b753d', '', now());

-- realign the serial above the chain max so post-fix explicit-id inserts never collide
SELECT setval('claims_id_seq', (SELECT max(id) FROM claims));

-- ----- verification before COMMIT -------------------------------------------
-- spot-check the former drift endpoints:
SELECT 'spot_19955' AS chk, id, action_id, claimer_id FROM claims WHERE id = 19955;  -- expect thaisinhar41 / 390
SELECT 'spot_19982' AS chk, id, action_id, claimer_id FROM claims WHERE id = 19982;  -- expect matteoa12345 / 389
SELECT 'spot_19871' AS chk, id, action_id, claimer_id FROM claims WHERE id = 19871;  -- expect welovecircus / 292
SELECT 'spot_19904' AS chk, id, action_id, claimer_id FROM claims WHERE id = 19904;  -- expect bananadacult / 123
-- expect 19962 rows total (19,960 + 2 backfilled), max id 19982:
SELECT 'totals' AS chk, count(*), max(id) FROM claims;
-- expect 0: nothing left in the temp range
SELECT 'temp_range_left' AS chk,
  (SELECT count(*) FROM claims WHERE id >= 1000000) +
  (SELECT count(*) FROM checks WHERE claim_id >= 1000000) +
  (SELECT count(*) FROM notification_history WHERE claim_id >= 1000000);
-- expect 0: no orphaned checks
SELECT 'orphan_checks' AS chk, count(*) FROM checks k
  WHERE NOT EXISTS (SELECT 1 FROM claims c WHERE c.id = k.claim_id);

-- ROLLBACK;  -- if anything looks off
-- COMMIT;    -- only after every expect-check above matches
