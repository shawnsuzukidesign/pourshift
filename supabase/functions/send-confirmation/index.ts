// PourShift, Supabase Edge Function
// Triggered by a Database Webhook on INSERT into public.waitlist_signups.
// Sends a branded confirmation email via Resend, picking the right template
// based on signup_type.
//
// Required environment variables (set in the Supabase dashboard):
//   RESEND_API_KEY       , your Resend API key (starts "re_")
//   FROM_EMAIL           , e.g. "PourShift <support@pourshift.com>"
//   WEBHOOK_SECRET       , shared secret; same value in the webhook header
//   TEMPLATES_BASE_URL   , where to fetch email templates from, e.g.
//                           "https://pourshift.com/emails" or the Netlify URL.
//                           Files expected: bartender-confirmation.html,
//                           venue-confirmation.html
//
// The webhook MUST be configured to send a header:
//   X-Webhook-Secret: <same value as WEBHOOK_SECRET>
// We reject anything without it. This is the only auth on the function -
// `verify_jwt: false` is required because Supabase webhooks don't send JWTs.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// In-memory cache for templates so we're not hammering the static host on
// every send. Cleared whenever the function cold-starts.
const TEMPLATE_CACHE = new Map<string, string>();

async function getTemplate(name: string): Promise<string> {
  if (TEMPLATE_CACHE.has(name)) return TEMPLATE_CACHE.get(name)!;
  const base = Deno.env.get("TEMPLATES_BASE_URL");
  if (!base) throw new Error("TEMPLATES_BASE_URL not set");
  const url = `${base.replace(/\/$/, "")}/${name}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch template ${url}: ${res.status}`);
  const html = await res.text();
  TEMPLATE_CACHE.set(name, html);
  return html;
}

function fill(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(escapeHtml(v));
  }
  return out;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function firstName(full: string): string {
  if (!full) return "there";
  return full.trim().split(/\s+/)[0];
}

function plainTextFallback(html: string): string {
  // Crude HTML → text for the multipart/alternative version. Email clients
  // that don't render HTML (or that strip it) fall back to this.
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Auth: shared secret header set on the Supabase Database Webhook.
  const expected = Deno.env.get("WEBHOOK_SECRET");
  const provided = req.headers.get("X-Webhook-Secret");
  if (!expected || provided !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const FROM_EMAIL = Deno.env.get("FROM_EMAIL");
  if (!RESEND_API_KEY || !FROM_EMAIL) {
    console.error("Missing RESEND_API_KEY or FROM_EMAIL env var");
    return new Response("Server misconfigured", { status: 500 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Supabase Database Webhook payload shape:
  //   { type: "INSERT", table, schema, record, old_record }
  if (payload?.type !== "INSERT" || payload?.table !== "waitlist_signups") {
    return new Response(JSON.stringify({ skipped: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const row = payload.record ?? {};
  const email = String(row.email || "").trim();
  const name = String(row.name || "").trim();
  const signupType = String(row.signup_type || "").trim();

  if (!email || !signupType) {
    return new Response("Row missing required fields", { status: 400 });
  }

  let subject = "";
  let html = "";

  try {
    if (signupType === "bartender") {
      const city = String(row.city || "").trim();
      const state = String(row.state || "").trim();
      const location = [city, state].filter(Boolean).join(", ") || "your area";
      const tpl = await getTemplate("bartender-confirmation.html");
      subject = "You're on the PourShift bartender waitlist";
      html = fill(tpl, { NAME: firstName(name), LOCATION: location });
    } else if (signupType === "venue") {
      const venueName = String(row.venue_name || "your venue").trim();
      const tier = String(row.preferred_subscription_tier || "Not sure yet").trim();
      const tpl = await getTemplate("venue-confirmation.html");
      subject = `${venueName} is on the PourShift venue waitlist`;
      html = fill(tpl, { NAME: firstName(name), VENUE_NAME: venueName, PREFERRED_TIER: tier });
    } else {
      return new Response("Unknown signup_type", { status: 400 });
    }
  } catch (e) {
    console.error("Template error", e);
    return new Response(`Template error: ${e instanceof Error ? e.message : e}`, { status: 500 });
  }

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [email],
      reply_to: "support@pourshift.com",
      subject,
      html,
      text: plainTextFallback(html),
      headers: {
        "List-Unsubscribe": "<mailto:support@pourshift.com?subject=unsubscribe>",
      },
      tags: [
        { name: "category", value: "waitlist_confirmation" },
        { name: "signup_type", value: signupType },
      ],
    }),
  });

  if (!resendRes.ok) {
    const errBody = await resendRes.text();
    console.error("Resend send failed", resendRes.status, errBody);
    return new Response(
      JSON.stringify({ ok: false, status: resendRes.status, error: errBody }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  const ok = await resendRes.json();
  return new Response(
    JSON.stringify({ ok: true, id: ok.id, sent_to: email, signup_type: signupType }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
