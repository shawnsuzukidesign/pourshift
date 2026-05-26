/* PourShift, form handler (shared by bartender + venue pages).
 *
 * Security layers:
 *   1. Client-side validation (UX only, never trusted)
 *   2. Honeypot field (rejects naive bots that fill every input)
 *   3. Time-trap (rejects submissions faster than humans can type)
 *   4. Supabase RLS: anon role can ONLY insert, not select/update/delete
 *   5. Supabase CHECK constraints: validates signup_type, lengths,
 *      email format, and role-specific required fields
 *
 * NEVER trust this file alone. Postgres RLS + CHECK constraints are
 * the source of truth.
 */

(function () {
  "use strict";

  const cfg = window.POURSHIFT_CONFIG;
  if (!cfg) { console.error("POURSHIFT_CONFIG missing"); return; }

  // -------------------------------------------------------------------
  // Tiny safe-DOM helpers (no innerHTML on user data, ever)
  // -------------------------------------------------------------------
  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function setText(el, text) { if (el) el.textContent = String(text == null ? "" : text); }

  function showMsg(form, type, text) {
    const box = $(".form-msg", form);
    if (!box) return;
    box.className = "form-msg is-visible is-" + type;
    setText(box, text);
  }
  function hideMsg(form) {
    const box = $(".form-msg", form);
    if (!box) return;
    box.className = "form-msg";
    setText(box, "");
  }

  function showFieldError(input, msg) {
    input.classList.add("is-invalid");
    const err = input.parentElement.querySelector(".field-error");
    if (err) { err.classList.add("is-visible"); setText(err, msg); }
  }
  function clearFieldErrors(form) {
    $$(".is-invalid", form).forEach(el => el.classList.remove("is-invalid"));
    $$(".field-error", form).forEach(el => { el.classList.remove("is-visible"); setText(el, ""); });
  }

  // -------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------
  const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  const URL_RE   = /^https?:\/\/[^\s]{3,500}$/i;

  function trim(v)        { return (v == null ? "" : String(v)).trim(); }
  function nonEmpty(v)    { return trim(v).length > 0; }
  function len(v, min, max) {
    const n = trim(v).length;
    return n >= min && n <= max;
  }

  function validate(form, signupType) {
    clearFieldErrors(form);
    const errors = [];

    function need(name, label, opts) {
      opts = opts || {};
      const input = form.elements[name];
      if (!input) return;
      const value = trim(input.value);
      if (!value) {
        showFieldError(input, label + " is required.");
        errors.push(label);
        return;
      }
      if (opts.max && value.length > opts.max) {
        showFieldError(input, label + " must be at most " + opts.max + " characters.");
        errors.push(label);
      }
      if (opts.re && !opts.re.test(value)) {
        showFieldError(input, opts.reMsg || ("Please enter a valid " + label.toLowerCase() + "."));
        errors.push(label);
      }
    }

    // Universal fields
    need("name",  "Name",  { max: 120 });
    need("email", "Email", { max: 254, re: EMAIL_RE, reMsg: "Please enter a valid email address." });
    need("city",  "City",  { max: 120 });
    need("state", "State / Province", { max: 80 });

    if (signupType === "bartender") {
      need("primary_role",        "Primary role",         { max: 80 });
      need("years_experience",    "Years of experience",  { max: 40 });

      // Multi-select: how do you currently find work?
      const sources = $$('input[name="current_work_sources"]:checked', form);
      if (sources.length === 0) {
        const group = $('[data-group="current_work_sources"]', form);
        if (group) {
          const err = group.querySelector(".field-error");
          if (err) { err.classList.add("is-visible"); setText(err, "Select at least one option."); }
        }
        errors.push("current_work_sources");
      } else if (sources.length > 20) {
        errors.push("too many work sources");
      }

      const checks = $$('input[name="worker_needs"]:checked', form);
      if (checks.length === 0) {
        const group = $('[data-group="worker_needs"]', form);
        if (group) {
          const err = group.querySelector(".field-error");
          if (err) { err.classList.add("is-visible"); setText(err, "Select at least one option."); }
        }
        errors.push("worker_needs");
      } else if (checks.length > 20) {
        errors.push("too many worker_needs");
      }

      // resume_url and phone are optional, but validate format if filled
      const resume = trim(form.elements.resume_url ? form.elements.resume_url.value : "");
      if (resume) {
        if (resume.length > 500 || !URL_RE.test(resume)) {
          showFieldError(form.elements.resume_url, "Enter a valid URL (https://...) up to 500 characters.");
          errors.push("resume_url");
        }
      }
      const phone = trim(form.elements.phone ? form.elements.phone.value : "");
      if (phone && phone.length > 32) {
        showFieldError(form.elements.phone, "Phone is too long.");
        errors.push("phone");
      }
    } else if (signupType === "venue") {
      need("venue_name",                  "Venue name",                  { max: 160 });
      need("venue_type",                  "Venue type",                  { max: 80 });
      need("hiring_timeline",             "Hiring timeline",             { max: 80 });
      need("would_pay_invite_fee",        "Invite-fee answer",           { max: 40 });
      need("preferred_subscription_tier", "Preferred subscription tier", { max: 80 });
      need("current_hiring_cost",         "Current hiring cost",         { max: 80 });
      need("fair_hire_fee",               "Fair hire fee answer",        { max: 40 });

      const roles = $$('input[name="roles_hiring_for"]:checked', form);
      if (roles.length === 0) {
        const group = $('[data-group="roles_hiring_for"]', form);
        if (group) {
          const err = group.querySelector(".field-error");
          if (err) { err.classList.add("is-visible"); setText(err, "Select at least one role."); }
        }
        errors.push("roles_hiring_for");
      } else if (roles.length > 20) {
        errors.push("too many roles");
      }

      // If "Other" is among selected roles, the free-text input is required.
      const otherChecked = roles.some(el => el.value === "Other");
      const otherInput   = form.elements.roles_hiring_for_other;
      if (otherChecked) {
        const otherVal = trim(otherInput ? otherInput.value : "");
        if (!otherVal) {
          if (otherInput) showFieldError(otherInput, "Tell us what other role(s) you're hiring for.");
          errors.push("roles_hiring_for_other");
        } else if (otherVal.length > 200) {
          if (otherInput) showFieldError(otherInput, "Please keep this under 200 characters.");
          errors.push("roles_hiring_for_other");
        }
      }

      const frustration = trim(form.elements.biggest_hiring_frustration ? form.elements.biggest_hiring_frustration.value : "");
      if (frustration && frustration.length > 2000) {
        showFieldError(form.elements.biggest_hiring_frustration, "Please keep this under 2000 characters.");
        errors.push("frustration");
      }
    }

    return errors;
  }

  // -------------------------------------------------------------------
  // Build the row payload for Supabase
  // -------------------------------------------------------------------
  function buildPayload(form, signupType) {
    const v = (name) => trim(form.elements[name] ? form.elements[name].value : "");
    const multi = (name) => $$('input[name="' + name + '"]:checked', form).map(el => trim(el.value)).filter(Boolean);

    const base = {
      signup_type: signupType,
      name:  v("name"),
      email: v("email").toLowerCase(),
      phone: v("phone") || null,
      city:  v("city"),
      state: v("state"),
    };

    if (signupType === "bartender") {
      return Object.assign(base, {
        primary_role:           v("primary_role"),
        years_experience:       v("years_experience"),
        current_work_sources:   multi("current_work_sources"),
        worker_needs:           multi("worker_needs"),
        resume_url:             v("resume_url") || null,
      });
    }

    // venue
    const roles = multi("roles_hiring_for");
    return Object.assign(base, {
      venue_name:                  v("venue_name"),
      venue_type:                  v("venue_type"),
      roles_hiring_for:            roles,
      roles_hiring_for_other:      roles.indexOf("Other") !== -1 ? (v("roles_hiring_for_other") || null) : null,
      hiring_timeline:             v("hiring_timeline"),
      would_pay_invite_fee:        v("would_pay_invite_fee"),
      preferred_subscription_tier: v("preferred_subscription_tier"),
      current_hiring_cost:         v("current_hiring_cost"),
      fair_hire_fee:               v("fair_hire_fee"),
      biggest_hiring_frustration:  v("biggest_hiring_frustration") || null,
    });
  }

  // -------------------------------------------------------------------
  // Supabase REST insert
  //   - Uses PostgREST endpoint directly (no SDK download required)
  //   - anon key + apikey header are the standard public auth
  //   - RLS policy on the table is what actually enforces security
  // -------------------------------------------------------------------
  async function insertRow(payload) {
    const url = cfg.SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/waitlist_signups";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey":        cfg.SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + cfg.SUPABASE_ANON_KEY,
        "Prefer":        "return=minimal",
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) return { ok: true };

    let body = "";
    try { body = await res.text(); } catch (_) {}

    // Duplicate email per signup_type
    if (res.status === 409 || /duplicate key|unique/i.test(body)) {
      return { ok: false, dupe: true };
    }
    return { ok: false, status: res.status, body: body };
  }

  // -------------------------------------------------------------------
  // Wire up a form
  // -------------------------------------------------------------------
  function attachForm(form) {
    const signupType = form.getAttribute("data-signup-type");
    if (signupType !== "bartender" && signupType !== "venue") return;

    const startedAt = Date.now();
    const submitBtn = $('button[type="submit"]', form);

    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      hideMsg(form);

      // 1. Honeypot: if filled, silently pretend success (don't tip off bots)
      const hp = form.elements.company_website;   // honeypot name
      if (hp && trim(hp.value).length > 0) {
        showMsg(form, "success", "Thanks, you're on the waitlist.");
        form.reset();
        return;
      }

      // 2. Time trap
      if (Date.now() - startedAt < cfg.MIN_FORM_TIME_MS) {
        showMsg(form, "error", "Please take a moment to review the form before submitting.");
        return;
      }

      // 3. Client validation
      const errors = validate(form, signupType);
      if (errors.length > 0) {
        showMsg(form, "error", "Please fix the highlighted fields and try again.");
        return;
      }

      // 4. Submit to Supabase
      submitBtn.disabled = true;
      const origLabel = submitBtn.textContent;
      setText(submitBtn, "Submitting...");

      try {
        // Insert via Supabase (RLS enforces what's actually allowed)
        const payload = buildPayload(form, signupType);
        const result  = await insertRow(payload);

        if (result.ok) {
          showMsg(form, "success", "You're on the waitlist. We'll be in touch when early access opens in your area.");
          form.reset();
        } else if (result.dupe) {
          showMsg(form, "error", "This email is already on the " + signupType + " waitlist.");
        } else {
          showMsg(form, "error", "Something went wrong on our side. Please try again in a minute.");
          console.error("Insert failed", result);
        }
      } catch (e) {
        console.error(e);
        showMsg(form, "error", "Unexpected error. Please try again.");
      } finally {
        submitBtn.disabled = false;
        setText(submitBtn, origLabel);
      }
    });
  }

  // -------------------------------------------------------------------
  // Toggle the "Other" free-text input when its checkbox flips
  // -------------------------------------------------------------------
  function wireOtherToggles(form) {
    $$('input[type="checkbox"][data-other-toggle]', form).forEach(cb => {
      const wrap = form.querySelector(cb.closest("label").getAttribute("data-toggles"));
      if (!wrap) return;
      const sync = () => {
        wrap.hidden = !cb.checked;
        const inp = wrap.querySelector("input, textarea");
        if (inp && !cb.checked) inp.value = "";
      };
      cb.addEventListener("change", sync);
      sync();
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    $$("form[data-signup-type]").forEach(function (form) {
      wireOtherToggles(form);
      attachForm(form);
    });
  });
})();
