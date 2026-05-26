# PourShift waitlist confirmation emails, setup guide

This walks you through getting confirmation emails sending. **One-time setup, ~20 minutes**, mostly DNS waiting.

## What you're building

```
[Form submit]  →  [Supabase INSERT]  →  [Database Webhook]  →  [Edge Function]  →  [Resend]  →  [User's inbox]
```

The Edge Function (`send-waitlist-confirmation`) is **already deployed** to your Supabase project. You just need to:

1. Sign up for Resend and verify `pourshift.com`
2. Add 3 environment variables to the Edge Function
3. Add a Database Webhook in Supabase
4. (Optional) Add DMARC record for better deliverability

---

## Step 1, Sign up for Resend

1. Go to <https://resend.com/signup> and create an account
2. Click **Domains** → **Add Domain** → enter `pourshift.com`
3. Resend will show you 3 DNS records to add. They look something like:

| Type  | Name / Host                     | Value                                           |
| ----- | ------------------------------- | ----------------------------------------------- |
| MX    | `send`                          | `feedback-smtp.us-east-1.amazonses.com` (prio 10) |
| TXT   | `send`                          | `v=spf1 include:amazonses.com ~all`             |
| TXT   | `resend._domainkey`             | `p=MIGfMA0...` (long DKIM key)                  |

4. **In Cloudflare DNS** (where your DNS is managed), click **Add record** for each one
5. **Important**: For all three records, set proxy status to **DNS only** (grey cloud)
6. Wait 2-10 minutes, then click **Verify Domain** in Resend
7. Once verified, go to **API Keys** → **Create API Key** → name it "PourShift production" → scope "Sending access" → **save the key somewhere safe**, you won't see it again

> **Heads up on your existing SPF**: you already have `v=spf1 include:_spf.porkbun.com ~all` on the root domain (from Porkbun email forwarding). Resend's SPF goes on the `send` subdomain, so there's no conflict, they coexist.

---

## Step 2, Add the Edge Function secrets

1. Go to your Supabase dashboard → **Project settings** → **Edge Functions** → **Secrets** (or **Functions** → **send-waitlist-confirmation** → **Secrets**)
2. Add these three secrets:

| Name                 | Value                                                                                |
| -------------------- | ------------------------------------------------------------------------------------ |
| `RESEND_API_KEY`     | The key you saved in Step 1 (starts `re_`)                                           |
| `FROM_EMAIL`         | `PourShift <support@pourshift.com>`                                                  |
| `WEBHOOK_SECRET`     | `QuOItux_by2VX0XSV5cYAqal_zlseQmn_OT37DM26GY` (or generate your own 32+ char secret) |
| `TEMPLATES_BASE_URL` | `https://pourshift.com/emails` once your custom domain is live, otherwise your Netlify URL + `/emails` |

3. Click **Save**

---

## Step 3, Add the Database Webhook

1. In Supabase dashboard → **Database** → **Webhooks** → **Create a new webhook**
2. Fill it out:

| Field            | Value                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| Name             | `waitlist_signup_confirmation`                                                                         |
| Table            | `waitlist_signups`                                                                                     |
| Events           | ☑ Insert (only)                                                                                        |
| Type             | **Supabase Edge Functions**                                                                            |
| Edge Function    | `send-waitlist-confirmation`                                                                           |
| HTTP Method      | POST                                                                                                   |
| HTTP Headers     | `X-Webhook-Secret`: `<paste the same WEBHOOK_SECRET value>`                                            |
| HTTP Params      | (leave empty)                                                                                          |
| Timeout          | `5000` ms                                                                                              |

3. Click **Create webhook**

> The function rejects any request that doesn't include the matching `X-Webhook-Secret` header. That's the only auth, `verify_jwt` is off because Supabase Database Webhooks don't send JWTs.

---

## Step 4, Add a DMARC record (recommended, takes 30 seconds)

Improves inbox placement. In Cloudflare DNS, add:

| Type | Name      | Value                                                              |
| ---- | --------- | ------------------------------------------------------------------ |
| TXT  | `_dmarc`  | `v=DMARC1; p=none; rua=mailto:support@pourshift.com; pct=100; sp=none; aspf=r;` |

`p=none` means "monitor only, don't block anything." Once you're confident, you can ratchet to `p=quarantine` then `p=reject`. Keep proxy status **DNS only**.

---

## Step 5, Test it

Submit one bartender signup and one venue signup through the live forms. You should receive both confirmation emails within ~10 seconds. Check Resend's **Logs** tab to see the delivery status and the **Webhook history** in Supabase to see the webhook invocation.

If something doesn't work:

- **Email never arrives** → Check Resend → Logs. If 404 there, the function never called Resend; check Supabase → Edge Functions → `send-waitlist-confirmation` → Logs
- **"Unauthorized" in Edge Function logs** → The `WEBHOOK_SECRET` in the function secrets doesn't match the `X-Webhook-Secret` header in the webhook config
- **"TEMPLATES_BASE_URL not set"** → Add that secret in Step 2
- **"Could not fetch template ...: 404"** → Your `TEMPLATES_BASE_URL` is wrong. The function fetches `<base>/bartender-confirmation.html` etc. Verify the templates are deployed at that URL.

---

## Operations

- **Pricing**: Resend's free tier is 3,000 emails/month, 100/day. Plenty of headroom for waitlist phase. Their paid tier starts at $20/mo if you outgrow it.
- **Editing email copy**: Just edit `/emails/bartender-confirmation.html` or `/emails/venue-confirmation.html` and redeploy the site. The function fetches templates fresh on cold-start, so changes go live within a few minutes (or you can manually invoke the function once to warm the cache).
- **Viewing sends**: Resend dashboard → Emails. You can see delivery status, opens, bounces.
- **Replies**: Replies to `support@pourshift.com` get forwarded by Porkbun to wherever you set up the forward originally. If you haven't, log in to Porkbun → Email Forwarding → forward `support@` to your Gmail.

---

## What the user sees

**Bartender signup:**
- Subject: `You're on the PourShift bartender waitlist`
- Personalized with first name + location

**Venue signup:**
- Subject: `<Venue Name> is on the PourShift venue waitlist`
- Personalized with name + venue name + their selected tier callout

Both emails are mobile-responsive, use your brand (Lora/Lato/gold), invite reply-based engagement, and ship with a `List-Unsubscribe` header for inbox-provider trust.
