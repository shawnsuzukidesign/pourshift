/* PourShift, public config.
   These values ship to the browser. Write protection comes from
   Supabase RLS + CHECK constraints (server-side), not from hiding
   the anon key. */

window.POURSHIFT_CONFIG = {
  SUPABASE_URL:      "https://oaaznwuuzkcotcvzjpgs.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9hYXpud3V1emtjb3RjdnpqcGdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMzgzMzcsImV4cCI6MjA5NDgxNDMzN30.rwliNFLYLf1pIUVjLNzyrxLsL8t8atEs_OiG3F-KYa0",

  // Minimum form completion time (ms). Bots submit forms in < 1 second
  // far more often than humans. Forms submitted faster than this are
  // silently treated as bots.
  MIN_FORM_TIME_MS: 2500,

  // Bot protection: honeypot field (company_website) + time-trap above.
  // If spam becomes an issue, add Cloudflare Turnstile or reCAPTCHA later.
};
