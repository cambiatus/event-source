-- Minimal schema for verifyClaim / cancelClaim / claim_mirror tests (vote-comments).
-- Only the tables and columns those updaters touch. The backend adds
-- claim_status 'cancelled' and checks.memo in its own migration; they are created here
-- so the tests run in a scratch database.
CREATE TYPE public.claim_status AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

CREATE TABLE public.users (
  account character varying PRIMARY KEY
);

CREATE TABLE public.actions (
  id bigint PRIMARY KEY,
  verifications integer NOT NULL DEFAULT 1,
  usages integer NOT NULL DEFAULT 0,
  usages_left integer NOT NULL DEFAULT 0,
  is_completed boolean NOT NULL DEFAULT false
);

CREATE TABLE public.claims (
  id bigint PRIMARY KEY,
  action_id bigint NOT NULL,
  claimer_id character varying NOT NULL,
  status public.claim_status NOT NULL DEFAULT 'pending'
);

CREATE TABLE public.checks (
  id bigserial PRIMARY KEY,
  claim_id bigint NOT NULL REFERENCES public.claims (id),
  validator_id character varying NOT NULL REFERENCES public.users (account),
  is_verified boolean NOT NULL,
  created_block integer,
  created_tx character varying,
  created_eos_account character varying,
  created_at timestamp without time zone,
  memo text
);
CREATE UNIQUE INDEX checks_claim_validator ON public.checks (claim_id, validator_id);

CREATE TABLE public.member_action_claims (
  account character varying NOT NULL,
  action_id bigint NOT NULL,
  pending integer NOT NULL DEFAULT 0,
  approved integer NOT NULL DEFAULT 0,
  last_rejected_at timestamp(0) without time zone,
  updated_block integer,
  updated_at timestamp without time zone DEFAULT now(),
  PRIMARY KEY (account, action_id)
);
