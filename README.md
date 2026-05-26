# PourShift Waitlist Site

Static HTML/CSS/JS landing site for **PourShift** with two waitlist forms (Bartender + Venue) writing to a Supabase `waitlist_signups` table. Designed to deploy to **Netlify**.

```
pourshift/
├── index.html               Landing page
├── bartender.html           Bartender signup
├── venue.html               Venue signup
├── css/styles.css           Design system + components
├── js/config.js             Public config (Supabase URL + anon key)
├── js/form.js               Validation + honeypot + time-trap + Supabase insert
├── netlify.toml             Security headers + CSP
├── supabase_setup.sql       Schema fixes + RLS + CHECK constraints (reference)
└── README.md
```

---

## 1. Supabase setup (already applied)

The Supabase project `oaaznwuuzkcotcvzjpgs` already has:

- The broken `UNIQUE` constraints on `signup_type`, `resume_url`, `email` removed
- A composite unique index on `(lower(email), signup_type)` so one person can be on both waitlists, but not duplicated within one
- `resume_url` as nullable `text`
- CHECK constraints: signup_type whitelist, email format, length caps, array size caps
- A **conditional CHECK** so bartender rows must have all bartender fields, venue rows must have all venue fields, with no cross-contamination
- **RLS + FORCE RLS** enabled
- A single narrow policy `waitlist_anon_insert`: `anon` can **only INSERT** rows that pass validation
- SELECT/UPDATE/DELETE **revoked** from `anon` and `authenticated`, the service_role key is the only way to read submissions
- The `public.rls_auto_enable()` function locked down (EXECUTE revoked from anon/authenticated/PUBLIC)

`supabase_setup.sql` is included for reference / disaster recovery and is idempotent.

---

## 2. Configuration

### `js/config.js` (already filled in)

The Supabase URL and **anon** key ship to the browser. They are **public by design**, security comes from RLS + CHECK constraints in Postgres, not from hiding the anon key.

```js
window.POURSHIFT_CONFIG = {
  SUPABASE_URL:      "https://oaaznwuuzkcotcvzjpgs.supabase.co",
  SUPABASE_ANON_KEY: "eyJ...",
  MIN_FORM_TIME_MS:  2500,
};
```

If you ever rotate the anon key in Supabase, update this file and redeploy.

---

## 3. Deploy to Netlify

### Option A, drag and drop (fastest)

1. Zip the `pourshift/` folder
2. Go to <https://app.netlify.com/drop>
3. Drop the zip, get a live URL in ~10 seconds

No environment variables required. No build step. `netlify.toml` applies the security headers automatically.

### Option B, Git (recommended for ongoing work)

```bash
cd pourshift
git init && git add -A && git commit -m "PourShift waitlist site"
git remote add origin <your-repo>
git push -u origin main
```

In Netlify: **Add new site → Import from Git** → pick your repo. No build command needed.

### Custom domain (pourshift.com)

Domain is registered at Porkbun with DNS managed by Cloudflare. To point it at Netlify, in the Cloudflare DNS panel:

1. **Delete** the existing `ALIAS` and `CNAME` records pointing to `uixie.porkbun.com`
2. **Add** an `A` record: name `@`, value `75.2.60.5`, proxy status **DNS only** (grey cloud)
3. **Add** a `CNAME` record: name `www`, value `apex-loadbalancer.netlify.com`, proxy status **DNS only**

Leave the `MX`, `SPF`/`TXT`, and `_acme-challenge` records alone. Netlify will issue an SSL cert automatically once DNS propagates.

---

## 4. Security model (defense in depth)

| Layer            | What it does                                                                  | Where                                |
| ---------------- | ----------------------------------------------------------------------------- | ------------------------------------ |
| HTTPS + HSTS     | TLS everywhere, prevents downgrade                                            | Netlify (auto) + `netlify.toml`      |
| Security headers | X-Frame, X-Content-Type, Referrer, Permissions, **strict CSP**                | `netlify.toml`                       |
| Honeypot         | Hidden `company_website` field, bots fill it, real users don't               | `bartender.html` / `venue.html`     |
| Time trap        | Reject submissions under 2.5s (humans don't type that fast)                   | `js/form.js`                         |
| Client validation | UX-only, sanity checks before send                                          | `js/form.js`                         |
| RLS              | `anon` role can only INSERT, never SELECT/UPDATE/DELETE                       | Supabase (applied)                   |
| CHECK constraints | Enforce signup_type, email format, length caps, role-specific required fields | Supabase (applied)                   |
| Unique index     | Prevents duplicate `(email, signup_type)` submissions                          | Supabase (applied)                   |
| SQL injection    | Not possible, uses PostgREST parameterized API, no raw SQL from client       | by design                            |
| XSS              | All user content rendered via `textContent`, never `innerHTML`                | `js/form.js`                         |

**SQL injection is fundamentally not possible** here, the browser talks to Supabase via PostgREST, which uses parameterized queries. The client never constructs SQL. Even if an attacker tampered with the JS, RLS and CHECK constraints in Postgres would reject anything outside the allowed shape.

### Bot protection

The site uses a **honeypot field + 2.5-second time-trap** for bot defense. This catches the overwhelming majority of automated spam without making real users solve a puzzle or get tracked by Google. If you ever start seeing significant spam, drop in [Cloudflare Turnstile](https://www.cloudflare.com/products/turnstile/) (free, privacy-friendly, one script tag + one server check), it's the lowest-friction upgrade path.

---

## 5. Read submissions

Use the Supabase dashboard (Table editor → `waitlist_signups`), the service_role behind the dashboard can read everything.

For programmatic access from your own backend, use the **service_role key** (kept server-side only, never put in a browser):

```bash
curl 'https://oaaznwuuzkcotcvzjpgs.supabase.co/rest/v1/waitlist_signups?select=*' \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

---

## 6. Local development

Just open `index.html` in a browser, it works as static files. Or run a tiny static server:

```bash
cd pourshift
python3 -m http.server 8000
# then visit http://localhost:8000
```


## 7. Bartender search ranking (design notes for build)

The cert-priority badge ($9.99/mo) gives subscribers a search-ranking
boost above non-subscribers. To keep that boost from becoming pure
pay-to-win, ranking is computed from several signals and the badge is
a tiebreaker among otherwise-comparable profiles.

**Ranking signals, in priority order:**

1. **Certification status.** Active RBS / food handler / city permits
   rank above expired. Bartenders with all expired certs are already
   reclassified to barback per the cert-aware-profiles rule and only
   appear in barback searches.
2. **Profile completeness score (0 to 100%).** Pour video uploaded,
   photo, bio, certifications uploaded, all profile fields filled.
   Incomplete profiles never rank above complete ones, regardless of
   badge.
3. **Pour video count and recency.** More videos = more proof. New
   videos in the last 90 days give a small boost.
4. **Recent activity.** Logged in within the last 14 days ranks
   higher. Stale profiles drop.
5. **Verified hire history on PourShift.** Each verified hire earns
   persistent ranking weight (cold-start protection: no penalty for
   no hires yet).
6. **Cert-priority badge subscriber.** Tiebreaker boost among
   otherwise comparable profiles. Not a magic ticket to the top.

**Implementation sketch:** compute a per-bartender `rank_score` as a
weighted sum of the signals above (e.g. cert_status * 100 +
completeness_pct * 10 + recent_video_bonus + recent_activity_bonus +
hire_count * 5 + badge_subscriber * 3). Sort venue search results by
`rank_score DESC`. Recompute on profile change, on cert state change,
and on a nightly cron for recency decay.

**Why this design:** what venues are paying for is trust. If a paid
badge let a half-finished, ghost-account profile jump to the top of
the stack, the trust story collapses on the first bad hire. Gating
the badge behind cert + completeness + activity protects the brand
on both sides of the marketplace.


## 8. Pricing (current) and founding-promo playbook (future)

**Current pricing (publicly displayed):**

- Venues pay $50 per interview invite and $200 total per hire ($150
  due at hire after the invite fee is credited).
- Workers are free; $75 bonus on each of their first 4 hires through
  the platform ($300 max), paid 7-10 business days after the venue
  confirms and pays.
- Optional venue subscriptions: Standard $20/mo (3 invites + job
  listings), Pro $50/mo (10 invites + custom video requests +
  shortlists).
- Optional bartender cert-priority badge: $9.99/mo (green check +
  ranking boost when cert current and profile complete).

