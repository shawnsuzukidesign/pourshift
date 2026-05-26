-- =====================================================================
-- PourShift waitlist_signups, schema fixes + RLS hardening
-- Run this in the Supabase SQL Editor (Database > SQL Editor > New query)
-- =====================================================================
--
-- This script:
--   1. Fixes incorrect constraints on your existing table
--   2. Makes role-specific fields nullable (bartender vs venue use different fields)
--   3. Adds CHECK constraints, length limits, and validation to block junk/abuse
--   4. Enables Row Level Security (RLS)
--   5. Creates a narrow INSERT-only policy for the public `anon` role
--   6. Adds an index on email + signup_type for fast dedupe lookups
--
-- Safe to re-run: uses IF EXISTS / IF NOT EXISTS / DROP POLICY IF EXISTS.
-- =====================================================================


-- ---------- 1. Fix broken UNIQUE constraints --------------------------
-- signup_type must NOT be unique (you want many bartenders + many venues).
-- resume_url must NOT be unique and must be nullable (optional field).
-- email being unique is also problematic if the same person wants to sign
-- up as both a bartender AND a venue, we replace it with a composite
-- unique on (email, signup_type) instead.

ALTER TABLE public.waitlist_signups
  DROP CONSTRAINT IF EXISTS waitlist_signups_signup_type_key;

ALTER TABLE public.waitlist_signups
  DROP CONSTRAINT IF EXISTS waitlist_signups_resume_url_key;

ALTER TABLE public.waitlist_signups
  DROP CONSTRAINT IF EXISTS waitlist_signups_email_key;


-- ---------- 2. Make role-specific fields nullable ---------------------
-- Bartenders fill: primary_role, years_experience, current_work_source,
--                  worker_needs, resume_url (optional), phone (optional)
-- Venues fill:     venue_name, venue_type, roles_hiring_for,
--                  hiring_timeline, would_pay_invite_fee,
--                  preferred_subscription_tier, biggest_hiring_frustration

ALTER TABLE public.waitlist_signups
  ALTER COLUMN phone                          DROP NOT NULL,
  ALTER COLUMN primary_role                   DROP NOT NULL,
  ALTER COLUMN years_experience               DROP NOT NULL,
  ALTER COLUMN current_work_source            DROP NOT NULL,
  ALTER COLUMN worker_needs                   DROP NOT NULL,
  ALTER COLUMN resume_url                     DROP NOT NULL,
  ALTER COLUMN venue_name                     DROP NOT NULL,
  ALTER COLUMN venue_type                     DROP NOT NULL,
  ALTER COLUMN roles_hiring_for               DROP NOT NULL,
  ALTER COLUMN hiring_timeline                DROP NOT NULL,
  ALTER COLUMN would_pay_invite_fee           DROP NOT NULL,
  ALTER COLUMN preferred_subscription_tier    DROP NOT NULL,
  ALTER COLUMN biggest_hiring_frustration     DROP NOT NULL;

-- resume_url should be a single text value, not an array, to match the
-- single URL input in the form. Convert if it's currently text[].
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'waitlist_signups'
      AND column_name = 'resume_url'
      AND data_type = 'ARRAY'
  ) THEN
    ALTER TABLE public.waitlist_signups
      ALTER COLUMN resume_url TYPE text USING resume_url[1];
  END IF;
END$$;


-- ---------- 3. Validation constraints (defense in depth) --------------
-- Even though the JS client validates, never trust the client. These
-- CHECK constraints stop oversized payloads, bad signup_type values,
-- and obviously malformed emails from ever entering the database.
--
-- IMPORTANT: role-specific fields stay nullable at the COLUMN level,
-- but a conditional CHECK enforces that bartender rows must have all
-- bartender fields and venue rows must have all venue fields. This is
-- the right pattern for a single-table polymorphic signup.

ALTER TABLE public.waitlist_signups
  DROP CONSTRAINT IF EXISTS waitlist_signups_signup_type_check,
  DROP CONSTRAINT IF EXISTS waitlist_signups_email_format_check,
  DROP CONSTRAINT IF EXISTS waitlist_signups_name_len_check,
  DROP CONSTRAINT IF EXISTS waitlist_signups_email_len_check,
  DROP CONSTRAINT IF EXISTS waitlist_signups_phone_len_check,
  DROP CONSTRAINT IF EXISTS waitlist_signups_city_len_check,
  DROP CONSTRAINT IF EXISTS waitlist_signups_text_field_lens_check,
  DROP CONSTRAINT IF EXISTS waitlist_signups_resume_url_len_check,
  DROP CONSTRAINT IF EXISTS waitlist_signups_frustration_len_check,
  DROP CONSTRAINT IF EXISTS waitlist_signups_worker_needs_len_check,
  DROP CONSTRAINT IF EXISTS waitlist_signups_roles_hiring_len_check,
  DROP CONSTRAINT IF EXISTS waitlist_signups_role_fields_required_check;

ALTER TABLE public.waitlist_signups
  ADD CONSTRAINT waitlist_signups_signup_type_check
    CHECK (signup_type IN ('bartender', 'venue')),

  ADD CONSTRAINT waitlist_signups_email_format_check
    CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),

  ADD CONSTRAINT waitlist_signups_name_len_check
    CHECK (char_length(name) BETWEEN 1 AND 120),

  ADD CONSTRAINT waitlist_signups_email_len_check
    CHECK (char_length(email) <= 254),

  ADD CONSTRAINT waitlist_signups_phone_len_check
    CHECK (phone IS NULL OR char_length(phone) <= 32),

  ADD CONSTRAINT waitlist_signups_city_len_check
    CHECK (char_length(city) BETWEEN 1 AND 120),

  ADD CONSTRAINT waitlist_signups_resume_url_len_check
    CHECK (resume_url IS NULL OR char_length(resume_url) <= 500),

  ADD CONSTRAINT waitlist_signups_frustration_len_check
    CHECK (biggest_hiring_frustration IS NULL
           OR char_length(biggest_hiring_frustration) <= 2000),

  ADD CONSTRAINT waitlist_signups_worker_needs_len_check
    CHECK (worker_needs IS NULL OR array_length(worker_needs, 1) <= 20),

  ADD CONSTRAINT waitlist_signups_roles_hiring_len_check
    CHECK (roles_hiring_for IS NULL OR array_length(roles_hiring_for, 1) <= 20),

  -- Conditional required-fields enforcement based on signup_type.
  -- Bartender rows: every bartender-specific field must be present
  --                 (resume_url and phone stay optional per the form).
  -- Venue rows:     every venue-specific field must be present.
  -- Cross-role fields must be NULL on the opposite role so data
  -- stays clean (e.g. a venue row cannot accidentally contain
  -- worker_needs).
  ADD CONSTRAINT waitlist_signups_role_fields_required_check
    CHECK (
      (
        signup_type = 'bartender'
        AND primary_role        IS NOT NULL AND char_length(primary_role) > 0
        AND years_experience    IS NOT NULL AND char_length(years_experience) > 0
        AND current_work_source IS NOT NULL AND char_length(current_work_source) > 0
        AND worker_needs        IS NOT NULL AND array_length(worker_needs, 1) >= 1
        -- venue-only fields must be empty on bartender rows
        AND venue_name                  IS NULL
        AND venue_type                  IS NULL
        AND roles_hiring_for            IS NULL
        AND hiring_timeline             IS NULL
        AND would_pay_invite_fee        IS NULL
        AND preferred_subscription_tier IS NULL
        AND biggest_hiring_frustration  IS NULL
      )
      OR
      (
        signup_type = 'venue'
        AND venue_name                  IS NOT NULL AND char_length(venue_name) > 0
        AND venue_type                  IS NOT NULL AND char_length(venue_type) > 0
        AND roles_hiring_for            IS NOT NULL AND array_length(roles_hiring_for, 1) >= 1
        AND hiring_timeline             IS NOT NULL AND char_length(hiring_timeline) > 0
        AND would_pay_invite_fee        IS NOT NULL AND char_length(would_pay_invite_fee) > 0
        AND preferred_subscription_tier IS NOT NULL AND char_length(preferred_subscription_tier) > 0
        -- bartender-only fields must be empty on venue rows
        AND primary_role        IS NULL
        AND years_experience    IS NULL
        AND current_work_source IS NULL
        AND worker_needs        IS NULL
        AND resume_url          IS NULL
        -- biggest_hiring_frustration is OPTIONAL on venue form,
        -- so no NOT NULL requirement here
      )
    );


-- ---------- 4. Composite dedupe: one signup per (email, signup_type) --
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_signups_email_type_uniq
  ON public.waitlist_signups (lower(email), signup_type);


-- ---------- 5. Enable Row Level Security ------------------------------
ALTER TABLE public.waitlist_signups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waitlist_signups FORCE  ROW LEVEL SECURITY;


-- ---------- 6. Drop any prior policies, then create narrow ones -------
DROP POLICY IF EXISTS "waitlist_anon_insert"    ON public.waitlist_signups;
DROP POLICY IF EXISTS "waitlist_no_select_anon" ON public.waitlist_signups;
DROP POLICY IF EXISTS "waitlist_no_update_anon" ON public.waitlist_signups;
DROP POLICY IF EXISTS "waitlist_no_delete_anon" ON public.waitlist_signups;

-- Allow anonymous public users to INSERT only.
-- The check expression re-validates signup_type at the policy layer so
-- even a tampered client cannot insert something like signup_type='admin'.
CREATE POLICY "waitlist_anon_insert"
  ON public.waitlist_signups
  FOR INSERT
  TO anon
  WITH CHECK (
    signup_type IN ('bartender', 'venue')
    AND char_length(name) BETWEEN 1 AND 120
    AND char_length(email) BETWEEN 3 AND 254
    AND char_length(city) BETWEEN 1 AND 120
  );

-- Explicitly: anon cannot SELECT, UPDATE, or DELETE. With RLS enabled
-- and no permissive policy for those commands, all such requests are
-- denied. We don't need explicit deny policies, but revoke for safety:
REVOKE SELECT, UPDATE, DELETE ON public.waitlist_signups FROM anon;
REVOKE SELECT, UPDATE, DELETE ON public.waitlist_signups FROM authenticated;

-- Grant only INSERT to anon (Supabase exposes this via PostgREST).
GRANT INSERT ON public.waitlist_signups TO anon;


-- ---------- 7. Done ---------------------------------------------------
-- After running this, your `anon` (public) key can ONLY insert rows
-- that pass both the column-level CHECK constraints AND the RLS policy
-- WITH CHECK expression. It cannot read, update, or delete any rows.
-- Use the `service_role` key (server-side only) to read submissions.


-- =====================================================================
-- ADDENDUM (May 2026): state column, multi-select work sources,
--                     hiring "Other" free-text, + user_id fix
-- =====================================================================

-- Fix latent bug: user_id was created NOT NULL UNIQUE by table-autogen,
-- which would have broken anon waitlist inserts at the second signup.
ALTER TABLE public.waitlist_signups DROP CONSTRAINT IF EXISTS waitlist_signups_user_id_key;
ALTER TABLE public.waitlist_signups ALTER COLUMN user_id DROP NOT NULL;

-- Add state (universal) + multi-select work sources + hiring "Other" text.
ALTER TABLE public.waitlist_signups ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE public.waitlist_signups ADD COLUMN IF NOT EXISTS current_work_sources text[];
-- Backfill from the old single-text column if present, then drop it.
UPDATE public.waitlist_signups
   SET current_work_sources = ARRAY[current_work_source]
 WHERE current_work_source IS NOT NULL AND current_work_sources IS NULL;
ALTER TABLE public.waitlist_signups DROP COLUMN IF EXISTS current_work_source;
ALTER TABLE public.waitlist_signups ADD COLUMN IF NOT EXISTS roles_hiring_for_other text;

-- Length / shape constraints for the new fields.
ALTER TABLE public.waitlist_signups
  DROP CONSTRAINT IF EXISTS waitlist_signups_state_len_check,
  DROP CONSTRAINT IF EXISTS waitlist_signups_current_work_sources_len_check,
  DROP CONSTRAINT IF EXISTS waitlist_signups_roles_hiring_for_other_len_check;

ALTER TABLE public.waitlist_signups
  ADD CONSTRAINT waitlist_signups_state_len_check
  CHECK ((state IS NULL) OR (char_length(state) BETWEEN 1 AND 80)),
  ADD CONSTRAINT waitlist_signups_current_work_sources_len_check
  CHECK ((current_work_sources IS NULL) OR (array_length(current_work_sources, 1) BETWEEN 1 AND 20)),
  ADD CONSTRAINT waitlist_signups_roles_hiring_for_other_len_check
  CHECK ((roles_hiring_for_other IS NULL) OR (char_length(roles_hiring_for_other) BETWEEN 1 AND 200));

-- Updated conditional CHECK: bartender rows need current_work_sources (array);
-- venue rows must supply roles_hiring_for_other when "Other" is selected.
ALTER TABLE public.waitlist_signups
  DROP CONSTRAINT IF EXISTS waitlist_signups_role_fields_required_check;

ALTER TABLE public.waitlist_signups
  ADD CONSTRAINT waitlist_signups_role_fields_required_check
  CHECK (
    (
      signup_type = 'bartender'
      AND primary_role IS NOT NULL AND char_length(primary_role) > 0
      AND years_experience IS NOT NULL AND char_length(years_experience) > 0
      AND current_work_sources IS NOT NULL AND array_length(current_work_sources, 1) >= 1
      AND worker_needs IS NOT NULL AND array_length(worker_needs, 1) >= 1
      AND venue_name IS NULL AND venue_type IS NULL
      AND roles_hiring_for IS NULL AND roles_hiring_for_other IS NULL
      AND hiring_timeline IS NULL AND would_pay_invite_fee IS NULL
      AND preferred_subscription_tier IS NULL
      AND biggest_hiring_frustration IS NULL
    )
    OR
    (
      signup_type = 'venue'
      AND venue_name IS NOT NULL AND char_length(venue_name) > 0
      AND venue_type IS NOT NULL AND char_length(venue_type) > 0
      AND roles_hiring_for IS NOT NULL AND array_length(roles_hiring_for, 1) >= 1
      AND hiring_timeline IS NOT NULL AND char_length(hiring_timeline) > 0
      AND would_pay_invite_fee IS NOT NULL AND char_length(would_pay_invite_fee) > 0
      AND preferred_subscription_tier IS NOT NULL AND char_length(preferred_subscription_tier) > 0
      AND primary_role IS NULL AND years_experience IS NULL
      AND current_work_sources IS NULL AND worker_needs IS NULL
      AND resume_url IS NULL
      AND (
        NOT ('Other' = ANY (roles_hiring_for))
        OR (roles_hiring_for_other IS NOT NULL AND char_length(roles_hiring_for_other) > 0)
      )
    )
  );


-- ---------- 8. Pricing-signal fields on venue signups -----------------
-- Two new columns on the venue side:
--   current_hiring_cost, what venues say they spend hiring a bartender today
--   fair_hire_fee,       what venues say feels fair for a flat hire fee
-- Both are short enum-style strings populated from <select> options.
-- They are REQUIRED on venue rows and must be NULL on bartender rows.

ALTER TABLE public.waitlist_signups
  ADD COLUMN IF NOT EXISTS current_hiring_cost text,
  ADD COLUMN IF NOT EXISTS fair_hire_fee       text;

-- Length / shape constraints for the new fields.
ALTER TABLE public.waitlist_signups
  DROP CONSTRAINT IF EXISTS waitlist_signups_current_hiring_cost_len_check,
  DROP CONSTRAINT IF EXISTS waitlist_signups_fair_hire_fee_len_check;

ALTER TABLE public.waitlist_signups
  ADD CONSTRAINT waitlist_signups_current_hiring_cost_len_check
  CHECK ((current_hiring_cost IS NULL) OR (char_length(current_hiring_cost) BETWEEN 1 AND 80)),
  ADD CONSTRAINT waitlist_signups_fair_hire_fee_len_check
  CHECK ((fair_hire_fee IS NULL) OR (char_length(fair_hire_fee) BETWEEN 1 AND 40));

-- Updated conditional CHECK, requires the two new fields on venue rows,
-- forbids them on bartender rows.
ALTER TABLE public.waitlist_signups
  DROP CONSTRAINT IF EXISTS waitlist_signups_role_fields_required_check;

ALTER TABLE public.waitlist_signups
  ADD CONSTRAINT waitlist_signups_role_fields_required_check
  CHECK (
    (
      signup_type = 'bartender'
      AND primary_role IS NOT NULL AND char_length(primary_role) > 0
      AND years_experience IS NOT NULL AND char_length(years_experience) > 0
      AND current_work_sources IS NOT NULL AND array_length(current_work_sources, 1) >= 1
      AND worker_needs IS NOT NULL AND array_length(worker_needs, 1) >= 1
      AND venue_name IS NULL AND venue_type IS NULL
      AND roles_hiring_for IS NULL AND roles_hiring_for_other IS NULL
      AND hiring_timeline IS NULL AND would_pay_invite_fee IS NULL
      AND preferred_subscription_tier IS NULL
      AND current_hiring_cost IS NULL
      AND fair_hire_fee IS NULL
      AND biggest_hiring_frustration IS NULL
    )
    OR
    (
      signup_type = 'venue'
      AND venue_name IS NOT NULL AND char_length(venue_name) > 0
      AND venue_type IS NOT NULL AND char_length(venue_type) > 0
      AND roles_hiring_for IS NOT NULL AND array_length(roles_hiring_for, 1) >= 1
      AND hiring_timeline IS NOT NULL AND char_length(hiring_timeline) > 0
      AND would_pay_invite_fee IS NOT NULL AND char_length(would_pay_invite_fee) > 0
      AND preferred_subscription_tier IS NOT NULL AND char_length(preferred_subscription_tier) > 0
      AND current_hiring_cost IS NOT NULL AND char_length(current_hiring_cost) > 0
      AND fair_hire_fee IS NOT NULL AND char_length(fair_hire_fee) > 0
      AND primary_role IS NULL AND years_experience IS NULL
      AND current_work_sources IS NULL AND worker_needs IS NULL
      AND resume_url IS NULL
      AND (
        NOT ('Other' = ANY (roles_hiring_for))
        OR (roles_hiring_for_other IS NOT NULL AND char_length(roles_hiring_for_other) > 0)
      )
    )
  );
