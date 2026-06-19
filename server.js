require('dotenv').config();
const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");

const twilio = require('twilio');

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const app = express();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PORT = process.env.PORT || 3000;

// Temporary in-memory store.
// Fine for testing. Later use Redis, Supabase, Firebase, or a database.
const payments = new Map();
const pendingCallerNames = new Map();

function normalizePhone(value) {
  if (!value) return "";
  const digits = String(value).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return String(value).trim();
}

function formatSessionTypeForAirtable(value) {
  const normalized = String(value || "").toLowerCase().trim();

  const labels = {
    just_listen: "Just Listen",
    react_with_me: "React With Me",
    hype_session: "Hype Session",
    keep_it_real: "Keep It Real",
    no_filter: "No Filter",
    not_provided: "Not Provided",
    "not provided": "Not Provided"
  };

  return labels[normalized] || value || "Not Provided";
}

function isTemplateValue(value) {
  const text = String(value || "");
  return text.includes("{{") || text.includes("}}");
}

function findMostRecentFallbackPayment() {
  const fallbackPayments = [...payments.values()]
    .filter((p) => {
      return (
        p &&
        p.paid === true &&
        p.sessionComplete !== true &&
        (
          p.fallbackRequested === true ||
          p.source === "twilio_queue_fallback" ||
          p.fallbackEntryHitAt ||
          p.queueFallbackTriggeredAt
        )
      );
    })
    .sort((a, b) => {
      const aTime = new Date(
        a.fallbackEntryHitAt ||
        a.queueFallbackTriggeredAt ||
        a.updatedAt ||
        a.paidAt ||
        0
      ).getTime();

      const bTime = new Date(
        b.fallbackEntryHitAt ||
        b.queueFallbackTriggeredAt ||
        b.updatedAt ||
        b.paidAt ||
        0
      ).getTime();

      return bTime - aTime;
    });

  return fallbackPayments[0] || null;
}

function findMostRecentActivePaidPayment() {
  const uniquePayments = [...new Set([...payments.values()])];

  const activePayments = uniquePayments
    .filter((p) => {
      return (
        p &&
        p.paid === true &&
        p.sessionComplete !== true &&
        p.timerStarted !== true
      );
    })
    .sort((a, b) => {
      const aTime = new Date(a.updatedAt || a.paidAt || 0).getTime();
      const bTime = new Date(b.updatedAt || b.paidAt || 0).getTime();
      return bTime - aTime;
    });

  return activePayments[0] || null;
}

function findPaymentForBlandTimer(req) {
  const rawPhone =
    req.body.phone_number ||
    req.body.phone ||
    req.body.from ||
    req.body.callerPhone ||
    req.body.customerPhone ||
    "";

  const rawCallId =
    req.body.call_id ||
    req.body.callId ||
    req.body.bland_call_id ||
    "";

  const phone = isTemplateValue(rawPhone) ? "" : normalizePhone(rawPhone);
  const callId = isTemplateValue(rawCallId) ? "" : String(rawCallId || "");

  let payment =
    (phone && payments.get(phone)) ||
    (callId && payments.get(callId)) ||
    [...payments.values()].find((p) => {
      return (
        p &&
        p.paid === true &&
        (
          normalizePhone(p.customerPhone) === phone ||
          normalizePhone(p.phone) === phone ||
          normalizePhone(p.callerPhone) === phone ||
          p.callId === callId ||
          p.blandCallId === callId ||
          p.fallbackBlandCallId === callId
        )
      );
    });

  if (!payment && isTemplateValue(rawPhone)) {
    payment = findMostRecentFallbackPayment();
  }

  return {
    payment,
    phone,
    callId,
    rawPhone,
    rawCallId
  };
}

const PAYMENT_LINKS = {
  "https://buy.stripe.com/aFadRa715deu0ug4aR3Ru00": {
    sessionLength: "15",
    price: "25",
    seconds: 900,
  },

  "https://buy.stripe.com/test_aFadRa715deu0ug4aR3Ru00": {
    sessionLength: "15",
    price: "25",
    seconds: 900,
  },
};

app.use(cors());

// Stripe webhook must use raw body BEFORE express.json()
app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET.trim()
      );
      console.log("Webhook verified");
    } catch (err) {
      console.error("Stripe webhook verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const callId =
        session.client_reference_id ||
        session.metadata?.call_id ||
        session.metadata?.callId ||
        session.customer_details?.phone ||
        session.id;

      const paymentLink = session.payment_link;
      const paymentLinkUrl = session.metadata?.payment_link_url;

      let matchedPlan = null;

      // Best option: identify by metadata if you add metadata to each payment link.
      if (session.metadata?.session_length) {
        matchedPlan = {
          sessionLength: session.metadata.session_length,
          price: session.metadata.price,
          seconds: Number(session.metadata.seconds),
        };
      }

      // Fallback: identify by full payment link URL if sent in metadata.
      if (!matchedPlan && paymentLinkUrl && PAYMENT_LINKS[paymentLinkUrl]) {
        matchedPlan = PAYMENT_LINKS[paymentLinkUrl];
      }

      // Last fallback: identify by amount.
      if (!matchedPlan) {
        const amount = session.amount_total;

        if (amount === 2500) matchedPlan = PAYMENT_LINKS["https://buy.stripe.com/aFadRa715deu0ug4aR3Ru00"];
      }

      const now = new Date();

const sessionSeconds =
  matchedPlan?.seconds ||
  Number(session.metadata?.seconds) ||
  900;

const paymentRecord = {
  paid: true,
  callId,
  stripeSessionId: session.id,
  customerPhone: session.customer_details?.phone || null,
  customerEmail: session.customer_details?.email || null,
  amountTotal: session.amount_total,
  currency: session.currency,
  paymentStatus: session.payment_status,
  plan: matchedPlan,
  paidAt: now.toISOString(),

// SESSION TIMER FIELDS
sessionStartedAt: null,
timerStarted: false,
sessionSeconds,
totalSessionSeconds: sessionSeconds,

twoMinuteWarningSent: false,
surveySmsSent: false,
sessionComplete: false,
};

payments.set(callId, paymentRecord);

if (paymentRecord.customerPhone) {
  payments.set(paymentRecord.customerPhone, paymentRecord);
}

if (paymentRecord.callId) {
  payments.set(paymentRecord.callId, paymentRecord);
}

const pendingName =
  pendingCallerNames.get(paymentRecord.customerPhone) ||
  pendingCallerNames.get(callId) ||
  pendingCallerNames.get(normalizePhone(callId));

if (pendingName) {
  paymentRecord.callerName = pendingName;
  paymentRecord.customerName = pendingName;
  paymentRecord.displayName = pendingName;

  console.log("PENDING CALLER NAME ATTACHED TO PAYMENT:", {
    phone: paymentRecord.customerPhone,
    callerName: pendingName
  });
}

console.log("Payment confirmed:", paymentRecord);

res.json({ received: true });
}
});

// JSON routes after Stripe raw webhook
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/", (req, res) => {
  res.json({
    status: "LyvvOut webhook server running",
    health: "/health",
    stripeWebhook: "/stripe-webhook",
    blandCheckPayment: "/bland/check-payment",
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/bland/hours-check", (req, res) => {
  try {
    const now = new Date();

    const centralFormatter24 = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      hourCycle: "h23"
    });

    const centralParts = centralFormatter24.formatToParts(now);

    const getPart = (type) =>
      centralParts.find((part) => part.type === type)?.value;

    let hour = Number(getPart("hour"));
    const minute = Number(getPart("minute"));

    if (Number.isNaN(hour)) hour = 0;
    if (hour === 24) hour = 0;

    const safeMinute = Number.isNaN(minute) ? 0 : minute;
    const minutesSinceMidnight = hour * 60 + safeMinute;

    /*
      LyvvOut Live Listener Hours:
      OPEN: 12:00 PM Central through 12:00 AM Central
      CLOSED: 12:01 AM Central through 11:59 AM Central
    */

    const isOpen =
      minutesSinceMidnight >= 720 || minutesSinceMidnight === 0;

    const centralTime = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short"
    }).format(now);

    const liveListenerOpen = isOpen ? "true" : "false";
    const route = isOpen ? "live_listener" : "ai_fallback";

    console.log("HOURS CHECK RESULT:", {
      source: req.body?.source || null,
      phone: req.body?.phone || req.body?.phone_number || null,
      call_id: req.body?.call_id || req.body?.callId || null,
      centralTime,
      hour,
      minute: safeMinute,
      minutesSinceMidnight,
      isOpen,
      live_listener_open: liveListenerOpen,
      route
    });

    return res.json({
      ok: true,

      timezone: "America/Chicago",
      central_time: centralTime,
      current_central_time: centralTime,

      live_hours: "12:00 PM Central Time through 12:00 AM Central Time",
      closed_hours: "12:01 AM Central Time through 11:59 AM Central Time",

      hour,
      minute: safeMinute,
      minutes_since_midnight: minutesSinceMidnight,

      // Bland route condition uses string values: "true" / "false"
      is_open: liveListenerOpen,
      live_listener_open: liveListenerOpen,

      // Extra boolean fields for logs/debugging only
      is_open_bool: isOpen,
      live_listener_open_bool: isOpen,

      route,
      hours_route: route,

      message: isOpen
        ? "Live listeners are open. Route to live listener."
        : "Live listeners are closed. Route to AI fallback."
    });
  } catch (error) {
    console.error("HOURS CHECK ERROR:", error);

    return res.status(200).json({
      ok: false,

      timezone: "America/Chicago",
      central_time: null,
      current_central_time: null,

      live_hours: "12:00 PM Central Time through 12:00 AM Central Time",
      closed_hours: "12:01 AM Central Time through 11:59 AM Central Time",

      hour: null,
      minute: null,
      minutes_since_midnight: null,

      is_open: "false",
      live_listener_open: "false",

      is_open_bool: false,
      live_listener_open_bool: false,

      route: "ai_fallback",
      hours_route: "ai_fallback",

      message: "Hours check failed. Route to AI fallback.",
      error: error.message
    });
  }
});

// Bland AI calls this after caller presses 1.
app.post("/bland/check-payment", async (req, res) => {
  try {
    console.log("CHECK PAYMENT REQUEST BODY:", req.body);

    const rawPhone =
      req.body.phone_number ||
      req.body.confirmed_phone_number ||
      req.body.phone ||
      req.body.from ||
      req.body.callerPhone ||
      req.body.customerPhone ||
      "";

    const phone = isTemplateValue(rawPhone) ? "" : normalizePhone(rawPhone);

    const callId =
      req.body.call_id ||
      req.body.callId ||
      req.body.client_reference_id ||
      "";

    const normalizedCallId = isTemplateValue(callId) ? "" : normalizePhone(callId);

    console.log("NORMALIZED CHECK VALUES:", {
      rawPhone,
      phone,
      callId,
      normalizedCallId
    });

    let payment =
      (phone && payments.get(phone)) ||
      (callId && payments.get(callId)) ||
      (normalizedCallId && payments.get(normalizedCallId)) ||
      [...payments.values()].find((p) => {
        return (
          p &&
          p.paid === true &&
          p.sessionComplete !== true &&
          (
            normalizePhone(p.customerPhone) === phone ||
            normalizePhone(p.phone) === phone ||
            normalizePhone(p.callerPhone) === phone ||
            p.callId === callId ||
            normalizePhone(p.callId) === normalizedCallId ||
            normalizePhone(p.callId) === phone ||
            p.blandCallId === callId ||
            p.fallbackBlandCallId === callId
          )
        );
      });

    console.log("PAYMENT LOOKUP RESULT:", payment || "NO PAYMENT FOUND");

    if (!payment || payment.paid !== true) {
      return res.json({
        ok: false,
        paid: false,
        paymentStatus: "not_found",
        payment_status: "not_found",
        message:
          "Payment has not been confirmed yet. Ask the caller to complete payment and press 1 again."
      });
    }

    const sessionSeconds =
      payment.totalSessionSeconds ||
      payment.sessionSeconds ||
      payment.plan?.seconds ||
      900;

    const sessionLength =
      payment.plan?.sessionLength ||
      String(Math.round(sessionSeconds / 60));

    const confirmedPhone =
      payment.customerPhone ||
      payment.phone ||
      payment.callerPhone ||
      phone;

    payment.paymentVerified = true;
    payment.paymentVerifiedAt = new Date().toISOString();
    payment.verifiedBlandCallId = callId || payment.verifiedBlandCallId || null;
    payment.blandCallId = callId || payment.blandCallId || null;
    payment.totalSessionSeconds = sessionSeconds;
    payment.sessionSeconds = sessionSeconds;
    payment.updatedAt = new Date().toISOString();

    return res.json({
      ok: true,
      paid: true,
      paymentStatus: "paid",
      payment_status: "paid",
      message: "Payment confirmed. Continue the call.",

      call_id: payment.callId || callId || confirmedPhone || null,
      bland_call_id: callId || payment.blandCallId || null,

      phone_number: confirmedPhone,
      confirmed_phone_number: confirmedPhone,
      customerPhone: confirmedPhone,
      customer_phone: confirmedPhone,

      session_length: sessionLength,
      session_seconds: sessionSeconds,
      total_session_seconds: sessionSeconds,

      stripe_session_id: payment.stripeSessionId || null
    });
  } catch (error) {
    console.error("CHECK PAYMENT ERROR:", error);

    return res.status(500).json({
      ok: false,
      paid: false,
      paymentStatus: "error",
      payment_status: "error",
      message: "Payment check failed.",
      error: error.message
    });
  }
});

app.post("/bland/update-caller-name", async (req, res) => {
  console.log("UPDATE CALLER NAME REQUEST:", req.body);

  const normalizePhone = (value) => {
    if (!value) return "";
    const digits = String(value).replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return String(value).trim();
  };

 const rawPhone =
  req.body.phone_number ||
  req.body.phone ||
  req.body.from ||
  req.body.callerPhone ||
  req.body.customerPhone ||
  "";
  const phone = normalizePhone(rawPhone);
  const callId = req.body.call_id || req.body.callId || "";
  const callerName = req.body.caller_name || req.body.name || "";

  const payment =
    payments.get(phone) ||
    payments.get(callId) ||
    [...payments.values()].find((p) => {
      return (
        p.paid === true &&
        (
          normalizePhone(p.customerPhone) === phone ||
          p.callId === callId
        )
      );
    });

  if (!payment) {
    return res.json({ ok: false, message: "No payment record found" });
  }

  if (callerName) {
    payment.customerName = callerName;
    payment.callerName = callerName;
    console.log("CALLER NAME UPDATED:", { phone, callerName });
  }

  return res.json({ ok: true, message: "Caller name updated", callerName });
});

app.post("/bland/lookup-ai-handoff", async (req, res) => {
  try {
    console.log("LOOKUP AI HANDOFF REQUEST:", req.body);

    const pickRealValue = (...values) => {
      for (const value of values) {
        if (!value) continue;
        if (isTemplateValue(value)) continue;

        const clean = String(value).trim();
        if (!clean) continue;

        return clean;
      }

      return "";
    };

    const rawPhone = pickRealValue(
      req.body.phone_number,
      req.body.confirmed_phone_number,
      req.body.phone,
      req.body.caller_number,
      req.body.from,
      req.body.callerPhone,
      req.body.customerPhone
    );

    const phone = normalizePhone(rawPhone);

    const callId = pickRealValue(
      req.body.call_id,
      req.body.callId,
      req.body.bland_call_id,
      req.body.fallback_bland_call_id
    );

    const language = String(req.body.language || "").toLowerCase().trim();
    const source = req.body.source || "ai_handoff_lookup";

    let payment =
      (phone && payments.get(phone)) ||
      (callId && payments.get(callId)) ||
      [...payments.values()].find((p) => {
        return (
          p &&
          p.paid === true &&
          p.sessionComplete !== true &&
          (
            normalizePhone(p.customerPhone) === phone ||
            normalizePhone(p.phone) === phone ||
            normalizePhone(p.callerPhone) === phone ||
            p.callId === callId ||
            p.blandCallId === callId ||
            p.fallbackBlandCallId === callId ||
            p.liveCallSid === callId ||
            p.fallbackTwilioCallSid === callId
          )
        );
      });

    if (!payment) {
      payment = findMostRecentFallbackPayment();

      if (payment) {
        console.log("LOOKUP AI HANDOFF RECOVERED USING RECENT FALLBACK PAYMENT:", {
          rawPhone,
          phone,
          callId,
          recoveredCustomerPhone: payment.customerPhone,
          recoveredSessionType: payment.sessionType
        });
      }
    }

    if (!payment) {
      payment = findMostRecentActivePaidPayment();

      if (payment) {
        console.log("LOOKUP AI HANDOFF RECOVERED USING ACTIVE PAID SESSION:", {
          rawPhone,
          phone,
          callId,
          recoveredCustomerPhone: payment.customerPhone,
          recoveredSessionType: payment.sessionType
        });
      }
    }

    if (!payment || payment.paid !== true) {
      console.log("LOOKUP AI HANDOFF: NO ACTIVE PAID SESSION FOUND", {
        rawPhone,
        phone,
        callId,
        language,
        source
      });

      return res.json({
        ok: false,
        found: false,
        paid: false,
        message: "No active paid handoff session found."
      });
    }

    const sessionSeconds =
      payment.totalSessionSeconds ||
      payment.sessionSeconds ||
      payment.plan?.seconds ||
      900;

    const sessionType =
      payment.sessionType ||
      payment.session_type ||
      payment.selectedPersona ||
      payment.selected_persona ||
      payment.sessionLabel ||
      payment.session_label ||
      "no_filter";

    const callerName =
      payment.callerName ||
      payment.customerName ||
      payment.displayName ||
      pendingCallerNames.get(payment.customerPhone) ||
      pendingCallerNames.get(payment.phone) ||
      pendingCallerNames.get(payment.callerPhone) ||
      pendingCallerNames.get(phone) ||
      "Caller";

    payment.fallbackBlandCallId = callId || payment.fallbackBlandCallId || null;
    payment.blandCallId = callId || payment.blandCallId || null;
    payment.lastAiHandoffLookupAt = new Date().toISOString();
    payment.language = language || payment.language || null;
    payment.source = source;
    payment.fallbackRequested = true;
    payment.fallbackEntryHitAt =
      payment.fallbackEntryHitAt || new Date().toISOString();
    payment.updatedAt = new Date().toISOString();

    payment.sessionType = sessionType;
    payment.session_type = sessionType;
    payment.selectedPersona = sessionType;
    payment.selected_persona = sessionType;
    payment.sessionLabel = sessionType;
    payment.session_label = sessionType;

    console.log("LOOKUP AI HANDOFF FOUND:", {
      phone,
      callId,
      callerName,
      sessionType,
      sessionSeconds,
      language,
      source,
      customerPhone: payment.customerPhone
    });

    return res.json({
      ok: true,
      found: true,
      paid: true,

      caller_name: callerName,
      callerName: callerName,
      customerName: callerName,

      phone_number: payment.customerPhone || payment.phone || phone,
      customerPhone: payment.customerPhone || payment.phone || phone,
      customer_phone: payment.customerPhone || payment.phone || phone,

      session_type: sessionType,
      sessionType: sessionType,
      selected_persona: sessionType,
      selectedPersona: sessionType,
      session_label: sessionType,
      sessionLabel: sessionType,

      session_seconds: sessionSeconds,
      total_session_seconds: sessionSeconds,

      language: language || payment.language || null,
      call_id: payment.callId || callId || null,
      bland_call_id: callId || payment.fallbackBlandCallId || null,

      message: "Active paid AI handoff session found."
    });
  } catch (error) {
    console.error("LOOKUP AI HANDOFF ERROR:", error);

    return res.status(500).json({
      ok: false,
      found: false,
      paid: false,
      error: error.message
    });
  }
});

app.post("/bland/save-caller-name", (req, res) => {
  try {
    console.log("SAVE CALLER NAME REQUEST:", req.body);

    const pickRealValue = (...values) => {
      for (const value of values) {
        if (!value) continue;
        if (isTemplateValue(value)) continue;

        const clean = String(value).trim();
        if (!clean) continue;

        return clean;
      }

      return "";
    };

    const rawPhone = pickRealValue(
      req.body.phone_number,
      req.body.confirmed_phone_number,
      req.body.phone,
      req.body.from,
      req.body.callerPhone,
      req.body.customerPhone
    );

    const phone = normalizePhone(rawPhone);

    const callId = pickRealValue(
      req.body.call_id,
      req.body.callId,
      req.body.bland_call_id,
      req.body.blandCallId,
      req.body.client_reference_id
    );

    const cleanName = pickRealValue(
      req.body.caller_name,
      req.body.callerName,
      req.body.customerName,
      req.body.customer_name,
      req.body.name,
      req.body.first_name,
      req.body.firstName
    );

    if (!cleanName) {
      console.log("SAVE CALLER NAME SKIPPED - NO REAL NAME:", {
        rawPhone,
        phone,
        callId
      });

      return res.json({
        ok: true,
        saved: false,
        caller_saved: false,
        message: "No real caller name was provided.",
        caller_name: "Caller",
        callerName: "Caller",
        phone_number: phone || rawPhone || null,
        call_id: callId || null
      });
    }

    if (phone) {
      pendingCallerNames.set(phone, cleanName);
    }

    if (rawPhone && !isTemplateValue(rawPhone)) {
      pendingCallerNames.set(rawPhone, cleanName);
    }

    if (callId) {
      pendingCallerNames.set(callId, cleanName);
      pendingCallerNames.set(normalizePhone(callId), cleanName);
    }

    let payment =
      (phone && payments.get(phone)) ||
      (callId && payments.get(callId)) ||
      (callId && payments.get(normalizePhone(callId))) ||
      [...payments.values()].find((p) => {
        return (
          p &&
          p.sessionComplete !== true &&
          (
            normalizePhone(p.customerPhone) === phone ||
            normalizePhone(p.phone) === phone ||
            normalizePhone(p.callerPhone) === phone ||
            p.callId === callId ||
            p.blandCallId === callId ||
            p.fallbackBlandCallId === callId ||
            normalizePhone(p.callId) === phone ||
            normalizePhone(p.callId) === normalizePhone(callId)
          )
        );
      });

    if (!payment && typeof findMostRecentActivePaidPayment === "function") {
      payment = findMostRecentActivePaidPayment();
    }

    if (payment) {
      payment.callerName = cleanName;
      payment.customerName = cleanName;
      payment.displayName = cleanName;
      payment.updatedAt = new Date().toISOString();

      if (callId) {
        payment.blandCallId = callId;
      }

      if (phone) {
        payment.callerPhone = payment.callerPhone || phone;
      }
    }

    console.log("CALLER NAME SAVED:", {
      rawPhone,
      phone,
      callId,
      callerName: cleanName,
      attachedToPayment: !!payment
    });

    return res.json({
      ok: true,
      saved: true,
      caller_saved: true,
      message: "Caller name saved.",

      caller_name: cleanName,
      callerName: cleanName,
      customerName: cleanName,

      phone_number: phone || rawPhone || payment?.customerPhone || null,
      confirmed_phone_number: phone || rawPhone || payment?.customerPhone || null,
      customerPhone: payment?.customerPhone || phone || rawPhone || null,
      customer_phone: payment?.customerPhone || phone || rawPhone || null,

      call_id: payment?.callId || callId || null,
      bland_call_id: callId || payment?.blandCallId || null,

      attachedToPayment: !!payment
    });
  } catch (error) {
    console.error("SAVE CALLER NAME ERROR:", error);

    return res.status(500).json({
      ok: false,
      saved: false,
      caller_saved: false,
      message: "Failed to save caller name.",
      error: error.message
    });
  }
});

app.post("/bland/save-session-type", (req, res) => {
  try {
    console.log("SAVE SESSION TYPE REQUEST:", req.body);

    const rawPhone =
      req.body.phone_number ||
      req.body.confirmed_phone_number ||
      req.body.phone ||
      req.body.caller_number ||
      req.body.from ||
      req.body.callerPhone ||
      req.body.customerPhone ||
      "";

    const call_id =
      req.body.call_id ||
      req.body.callId ||
      req.body.bland_call_id ||
      "";

    const session_type =
      req.body.session_type ||
      req.body.sessionType ||
      req.body.selected_persona ||
      req.body.selectedPersona ||
      req.body.persona ||
      "";

    const normalizedPhone = normalizePhone(rawPhone);
    const cleanSessionType = String(session_type || "").trim();

    const normalizeSessionType = (value) => {
      const raw = String(value || "").trim().toLowerCase();

      const map = {
        "1": "just_listen",
        "just listen": "just_listen",
        "just_listen": "just_listen",

        "2": "react_with_me",
        "react with me": "react_with_me",
        "react_with_me": "react_with_me",

        "3": "hype_session",
        "hype session": "hype_session",
        "hype_session": "hype_session",

        "4": "keep_it_real",
        "keep it real": "keep_it_real",
        "keep_it_real": "keep_it_real",

        "5": "no_filter",
        "no filter": "no_filter",
        "no_filter": "no_filter"
      };

      return map[raw] || raw.replace(/\s+/g, "_");
    };

    const normalizedSessionType = normalizeSessionType(cleanSessionType);

    if (!cleanSessionType) {
      console.log("SESSION TYPE SAVE FAILED - MISSING SESSION TYPE:", {
        rawPhone,
        normalizedPhone,
        call_id,
        body: req.body
      });

      return res.status(400).json({
        ok: false,
        message: "Missing session_type"
      });
    }

    let payment =
      (normalizedPhone && payments.get(normalizedPhone)) ||
      (call_id && payments.get(call_id)) ||
      [...payments.values()].find((p) => {
        return (
          p &&
          p.paid === true &&
          p.sessionComplete !== true &&
          (
            normalizePhone(p.customerPhone) === normalizedPhone ||
            normalizePhone(p.phone) === normalizedPhone ||
            normalizePhone(p.callerPhone) === normalizedPhone ||
            p.callId === call_id ||
            p.blandCallId === call_id ||
            p.fallbackBlandCallId === call_id
          )
        );
      });

    if (!payment) {
      const recentPaid = [...payments.values()]
        .filter((p) => p && p.paid === true && p.sessionComplete !== true)
        .sort((a, b) => {
          const aTime = new Date(a.updatedAt || a.paidAt || 0).getTime();
          const bTime = new Date(b.updatedAt || b.paidAt || 0).getTime();
          return bTime - aTime;
        });

      payment = recentPaid[0] || null;

      if (payment) {
        console.log("SESSION TYPE SAVE - USED MOST RECENT ACTIVE PAID SESSION:", {
          rawPhone,
          normalizedPhone,
          call_id,
          recoveredCustomerPhone: payment.customerPhone,
          recoveredSessionType: payment.sessionType
        });
      }
    }

    if (!payment) {
      console.log("SESSION TYPE SAVE FAILED - NO PAYMENT RECORD:", {
        rawPhone,
        normalizedPhone,
        call_id,
        session_type: cleanSessionType
      });

      return res.status(404).json({
        ok: false,
        message: "No payment/session record found to save session type"
      });
    }

    payment.sessionType = normalizedSessionType;
    payment.session_type = normalizedSessionType;
    payment.selectedPersona = normalizedSessionType;
    payment.selected_persona = normalizedSessionType;
    payment.sessionLabel = normalizedSessionType;
    payment.session_label = normalizedSessionType;
    payment.blandCallId = call_id || payment.blandCallId || null;
    payment.updatedAt = new Date().toISOString();

    console.log("SESSION TYPE SAVED:", {
      phone: normalizedPhone,
      call_id,
      sessionType: payment.sessionType,
      session_type: payment.session_type,
      selectedPersona: payment.selectedPersona
    });

    return res.json({
      ok: true,
      message: "Session type saved",

      sessionType: payment.sessionType,
      session_type: payment.session_type,

      selectedPersona: payment.selectedPersona,
      selected_persona: payment.selected_persona,

      sessionLabel: payment.sessionLabel,
      session_label: payment.session_label,

      phone_number: payment.customerPhone || payment.phone || normalizedPhone,
      customerPhone: payment.customerPhone || payment.phone || normalizedPhone,
      call_id: payment.callId || call_id || null
    });
  } catch (error) {
    console.error("SAVE SESSION TYPE ERROR:", error);

    return res.status(500).json({
      ok: false,
      message: "Failed to save session type",
      error: error.message
    });
  }
});

app.post("/bland/session-start", async (req, res) => {
  const {
    payment,
    phone,
    callId,
    rawPhone,
    rawCallId
  } = findPaymentForBlandTimer(req);

  console.log("SESSION START REQUEST:", {
    rawPhone,
    phone,
    rawCallId,
    callId,
    source: req.body.source,
    foundPayment: !!payment
  });

  if (!payment || payment.paid !== true) {
    return res.status(404).json({
      ok: false,
      paid: false,
      active: false,
      timer_started: false,
      error: "No active paid session found."
    });
  }

  const now = new Date();

  const totalSessionSeconds =
    payment.totalSessionSeconds ||
    payment.sessionSeconds ||
    payment.plan?.seconds ||
    900;

  const sessionType =
    payment.sessionType ||
    payment.session_type ||
    payment.selectedPersona ||
    payment.selected_persona ||
    payment.sessionLabel ||
    payment.session_label ||
    "no_filter";

  const callerName =
    payment.callerName ||
    payment.customerName ||
    payment.displayName ||
    pendingCallerNames.get(payment.customerPhone) ||
    pendingCallerNames.get(payment.phone) ||
    pendingCallerNames.get(payment.callerPhone) ||
    pendingCallerNames.get(phone) ||
    "Caller";

  payment.sessionType = sessionType;
  payment.session_type = sessionType;
  payment.selectedPersona = sessionType;
  payment.selected_persona = sessionType;
  payment.sessionLabel = sessionType;
  payment.session_label = sessionType;

  payment.callerName = callerName;
  payment.customerName = callerName;
  payment.displayName = callerName;

  if (payment.timerStarted === true && payment.liveSessionEndsAt) {
    console.log("SESSION START IGNORED - TIMER ALREADY STARTED:", {
      phone,
      callId,
      liveSessionEndsAt: payment.liveSessionEndsAt,
      sessionType
    });

    return res.json({
      ok: true,
      already_started: true,
      paid: true,
      active: true,
      timer_started: true,
      message: "Timer already started",

      caller_name: callerName,
      callerName: callerName,
      customerName: callerName,

      phone_number: payment.customerPhone || payment.phone || phone,
      customerPhone: payment.customerPhone || payment.phone || phone,
      customer_phone: payment.customerPhone || payment.phone || phone,

      session_type: sessionType,
      sessionType: sessionType,
      selected_persona: sessionType,
      selectedPersona: sessionType,
      session_label: sessionType,
      sessionLabel: sessionType,

      call_id: payment.callId || callId || payment.customerPhone,
      session_id: payment.sessionId || payment.activeSessionId || null,

      remaining_seconds: getLiveRemainingSeconds(payment),
      total_session_seconds: totalSessionSeconds,

      liveSessionStartedAt:
        payment.liveSessionStartedAt ||
        payment.aiSessionStartedAt ||
        payment.sessionStartedAt,

      liveSessionEndsAt: payment.liveSessionEndsAt,
      session_complete: payment.sessionComplete === true
    });
  }

  payment.timerStarted = true;
  payment.liveSessionActive = false;
  payment.aiSessionActive = true;

  payment.sessionStartedAt = payment.sessionStartedAt || now.toISOString();
  payment.aiSessionStartedAt = payment.aiSessionStartedAt || now.toISOString();
  payment.liveSessionStartedAt = payment.liveSessionStartedAt || now.toISOString();

  payment.liveSessionEndsAt = new Date(
    now.getTime() + totalSessionSeconds * 1000
  ).toISOString();

  payment.totalSessionSeconds = totalSessionSeconds;
  payment.sessionSeconds = totalSessionSeconds;

  payment.twoMinuteWarningSent = false;
  payment.surveySmsSent = false;
  payment.sessionComplete = false;

  payment.source = req.body.source || payment.source || "ai_fallback";
  payment.updatedAt = now.toISOString();

  if (callId) {
    payment.fallbackBlandCallId = callId;
    payment.blandCallId = callId;
  }

  console.log("AI/FALLBACK SESSION TIMER STARTED:", {
    customerPhone: payment.customerPhone,
    sessionId: payment.sessionId,
    callId,
    totalSessionSeconds,
    sessionType,
    callerName,
    sessionStartedAt: payment.sessionStartedAt,
    aiSessionStartedAt: payment.aiSessionStartedAt,
    liveSessionEndsAt: payment.liveSessionEndsAt,
    source: payment.source
  });

  return res.json({
    ok: true,
    paid: true,
    active: true,
    timer_started: true,
    message: "Timer started.",

    caller_name: callerName,
    callerName: callerName,
    customerName: callerName,

    phone_number: payment.customerPhone || payment.phone || phone,
    customerPhone: payment.customerPhone || payment.phone || phone,
    customer_phone: payment.customerPhone || payment.phone || phone,

    session_type: sessionType,
    sessionType: sessionType,
    selected_persona: sessionType,
    selectedPersona: sessionType,
    session_label: sessionType,
    sessionLabel: sessionType,

    call_id: payment.callId || callId || payment.customerPhone,
    session_id: payment.sessionId || payment.activeSessionId || null,

    remaining_seconds: totalSessionSeconds,
    total_session_seconds: totalSessionSeconds,

    liveSessionStartedAt: payment.liveSessionStartedAt,
    liveSessionEndsAt: payment.liveSessionEndsAt,
    session_complete: false
  });
});

app.post("/bland/two-minute-warning", async (req, res) => {
  console.log("TWO MINUTE WARNING REQUEST:", req.body);

  const normalizePhone = (value) => {
    if (!value) return "";
    const digits = String(value).replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return String(value).trim();
  };

  const rawPhone =
  req.body.phone_number ||
  req.body.phone ||
  req.body.from ||
  req.body.callerPhone ||
  req.body.customerPhone ||
  "";
  const phone = normalizePhone(rawPhone);
  const callId = req.body.call_id || req.body.callId || "";

  const payment =
    payments.get(phone) ||
    payments.get(callId) ||
    [...payments.values()].find((p) => {
      return (
        p.paid === true &&
        (
          normalizePhone(p.customerPhone) === phone ||
          p.callId === callId
        )
      );
    });

  if (!payment) {
    return res.json({ ok: false, message: "No payment record found" });
  }

  payment.twoMinuteWarningSent = true;
  payment.currentPrompt = "2-MINUTE WARNING";
  payment.currentPromptScript = "You have about two minutes remaining in your session. We are going to begin gently wrapping up.";
  payment.lastPromptType = "two_minute_warning";
  payment.lastPromptAt = new Date().toISOString();

  console.log("TWO MINUTE WARNING FIRED:", { phone, callId });

  return res.json({ ok: true, message: "Two minute warning recorded" });
});


app.post("/flex/call-log", async (req, res) => {
  console.log("CALL LOG REQUEST:", req.body);

const {
  listener_name,
  caller_phone,
  session_type,
  self_harm_mentioned,
  threats_made,
  terms_violated,
  abusive_language,
  emergency_services_needed,
  call_had_no_issues,
  notes
} = req.body;

  const now = new Date();
  const date = now.toLocaleDateString('en-US');
  const time = now.toLocaleTimeString('en-US');

  try {
    const response = await fetch('https://api.airtable.com/v0/appruXeM9l3bA1gf0/tblJVPDR5f2hMiZQT', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
fields: {
  "Listener Name": listener_name || "",
  "Caller Phone": caller_phone || "",
  "Session Type": formatSessionTypeForAirtable(session_type),

  "Did the caller express thoughts of self harm?":
    self_harm_mentioned === true || self_harm_mentioned === "true",

  "Did the caller make any threats?":
    threats_made === true || threats_made === "true",

  "Did the caller violate the terms and conditions?":
    terms_violated === true || terms_violated === "true",

  "Did the caller use abusive or threatening language towards the listener?":
    abusive_language === true || abusive_language === "true",

  "Was law enforcement or emergency services needed?":
    emergency_services_needed === true || emergency_services_needed === "true",

  "Call Had No Issues":
    call_had_no_issues === true || call_had_no_issues === "true",

  "Additional Notes": notes || ""
}
      })
    });

    const data = await response.json();
    console.log("AIRTABLE RESPONSE:", data);

    if (data.id) {
      return res.json({ ok: true, message: "Call log saved", id: data.id });
    } else {
      return res.status(400).json({ ok: false, message: "Failed to save", error: data });
    }
  } catch (error) {
    console.error("AIRTABLE ERROR:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/bland/session-status", async (req, res) => {
  const {
    payment,
    phone,
    callId,
    rawPhone,
    rawCallId
  } = findPaymentForBlandTimer(req);

  console.log("SESSION STATUS CHECK:", {
    rawPhone,
    phone,
    rawCallId,
    callId,
    source: req.body.source,
    foundPayment: !!payment
  });

  if (!payment || payment.paid !== true) {
    return res.status(404).json({
      ok: false,
      active: false,
      paid: false,
      timer_started: false,
      remaining_seconds: 0,
      elapsed_seconds: 0,
      total_session_seconds: 0,
      two_minute_warning_due: false,
      survey_due: false,
      session_complete: true,
      message: "No active paid session found."
    });
  }

  const totalSessionSeconds =
    payment.totalSessionSeconds ||
    payment.sessionSeconds ||
    payment.plan?.seconds ||
    900;

  const sessionType =
    payment.sessionType ||
    payment.session_type ||
    payment.selectedPersona ||
    payment.selected_persona ||
    payment.sessionLabel ||
    payment.session_label ||
    "no_filter";

  const callerName =
    payment.callerName ||
    payment.customerName ||
    payment.displayName ||
    pendingCallerNames.get(payment.customerPhone) ||
    pendingCallerNames.get(payment.phone) ||
    pendingCallerNames.get(payment.callerPhone) ||
    pendingCallerNames.get(phone) ||
    "Caller";

  payment.sessionType = sessionType;
  payment.session_type = sessionType;
  payment.selectedPersona = sessionType;
  payment.selected_persona = sessionType;
  payment.sessionLabel = sessionType;
  payment.session_label = sessionType;

  payment.callerName = callerName;
  payment.customerName = callerName;
  payment.displayName = callerName;

  if (payment.timerStarted !== true || !payment.liveSessionEndsAt) {
    return res.json({
      ok: true,
      active: true,
      paid: true,
      timer_started: payment.timerStarted === true,

      caller_name: callerName,
      callerName: callerName,
      customerName: callerName,

      phone_number: payment.customerPhone || payment.phone || phone,
      customerPhone: payment.customerPhone || payment.phone || phone,
      customer_phone: payment.customerPhone || payment.phone || phone,

      session_type: sessionType,
      sessionType: sessionType,
      selected_persona: sessionType,
      selectedPersona: sessionType,
      session_label: sessionType,
      sessionLabel: sessionType,

      call_id: payment.callId || callId || null,
      session_id: payment.sessionId || payment.activeSessionId || null,

      remaining_seconds: totalSessionSeconds,
      elapsed_seconds: 0,
      total_session_seconds: totalSessionSeconds,

      two_minute_warning_due: false,
      survey_due: false,
      session_complete: false,

      message: "Paid session found, but timer has not started yet."
    });
  }

  const remainingSeconds = getLiveRemainingSeconds(payment);
  const elapsedSeconds = Math.max(totalSessionSeconds - remainingSeconds, 0);

  const twoMinuteWarningDue =
    remainingSeconds <= 210 &&
    remainingSeconds > 120 &&
    payment.twoMinuteWarningSent !== true;

  const surveyDue =
    remainingSeconds <= 75 &&
    remainingSeconds > 0 &&
    payment.surveySmsSent !== true;

  const sessionComplete = remainingSeconds <= 0;

  if (twoMinuteWarningDue) {
    payment.twoMinuteWarningSent = true;
    payment.lastPromptType = "two_minute_warning";
    payment.lastPromptAt = new Date().toISOString();
  }

  if (surveyDue) {
    payment.surveySmsSent = true;
    payment.surveyDueAt = new Date().toISOString();
  }

  if (sessionComplete) {
    payment.sessionComplete = true;
    payment.aiSessionActive = false;
    payment.liveSessionActive = false;
    payment.completedReason = payment.completedReason || "paid_time_expired";
    payment.completedAt = payment.completedAt || new Date().toISOString();
  }

  payment.updatedAt = new Date().toISOString();

  console.log("SESSION STATUS RESULT:", {
    callId,
    phone,
    elapsedSeconds,
    remainingSeconds,
    totalSessionSeconds,
    sessionType,
    callerName,
    twoMinuteWarningDue,
    surveyDue,
    sessionComplete
  });

  return res.json({
    ok: true,
    active: !sessionComplete,
    paid: true,
    timer_started: true,

    caller_name: callerName,
    callerName: callerName,
    customerName: callerName,

    phone_number: payment.customerPhone || payment.phone || phone,
    customerPhone: payment.customerPhone || payment.phone || phone,
    customer_phone: payment.customerPhone || payment.phone || phone,

    session_type: sessionType,
    sessionType: sessionType,
    selected_persona: sessionType,
    selectedPersona: sessionType,
    session_label: sessionType,
    sessionLabel: sessionType,

    call_id: payment.callId || callId || null,
    session_id: payment.sessionId || payment.activeSessionId || null,

    remaining_seconds: remainingSeconds,
    elapsed_seconds: elapsedSeconds,
    total_session_seconds: totalSessionSeconds,

    two_minute_warning_due: twoMinuteWarningDue,
    survey_due: surveyDue,
    session_complete: sessionComplete,

    liveSessionStartedAt:
      payment.liveSessionStartedAt ||
      payment.aiSessionStartedAt ||
      payment.sessionStartedAt ||
      null,

    liveSessionEndsAt: payment.liveSessionEndsAt || null,

    message: sessionComplete
      ? "Session complete."
      : "Session is active."
  });
});

app.post("/twilio/spanish-ai-hold", async (req, res) => {
  try {
    console.log("SPANISH AI HOLD REQUEST:", {
      from: req.body.From,
      to: req.body.To,
      callSid: req.body.CallSid,
      direction: req.body.Direction
    });

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    response.say(
      { voice: "alice", language: "es-MX" },
      "Un momento. Estamos preparando tu sesión privada."
    );

    response.pause({ length: 15 });

    const spanishFallbackNumber =
      process.env.TWILIO_SPANISH_AI_FALLBACK_NUMBER || "+18303315988";

    const dial = response.dial({
      callerId: process.env.TWILIO_SPANISH_HOLD_NUMBER || req.body.To,
      answerOnBridge: true,
      timeout: 20
    });

    dial.number(spanishFallbackNumber);

    console.log("DIALING SPANISH AI FALLBACK NUMBER:", {
      from: req.body.From,
      callSid: req.body.CallSid,
      spanishFallbackNumber
    });

    res.type("text/xml");
    return res.send(response.toString());
  } catch (error) {
    console.error("SPANISH AI HOLD ERROR:", error);

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    response.say(
      { voice: "alice", language: "es-MX" },
      "Lo sentimos. No pudimos conectar tu sesión en este momento. Por favor intenta llamar de nuevo."
    );

    response.hangup();

    res.type("text/xml");
    return res.send(response.toString());
  }
});

app.post("/twilio/incoming-live-call", async (req, res) => {
  console.log("LIVE CALL INCOMING:", req.body);

  const twilio = require("twilio");
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const normalizePhone = (value) => {
    if (!value) return "";
    const digits = String(value).replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return String(value).trim();
  };

  const from = normalizePhone(req.body.From || req.body.caller_number || "");
  const callSid = req.body.CallSid || "";

  let payment =
  payments.get(from) ||
  payments.get(callSid) ||
  [...payments.values()].find((p) => {
    return (
      p &&
      p.paid === true &&
      p.sessionComplete !== true &&
      (
        normalizePhone(p.customerPhone) === from ||
        normalizePhone(p.phone) === from ||
        normalizePhone(p.callerPhone) === from ||
        p.callId === callSid ||
        p.liveCallSid === callSid ||
        normalizePhone(p.callId) === from
      )
    );
  });

if (!payment) {
  payment = findMostRecentActivePaidPayment();

  if (payment) {
    console.log("LIVE CALL PAYMENT RECOVERED USING MOST RECENT ACTIVE PAID SESSION:", {
      twilioFrom: from,
      callSid,
      recoveredCustomerPhone: payment.customerPhone,
      recoveredSessionType: payment.sessionType,
      paidAt: payment.paidAt
    });
  }
}

  if (!payment) {
    response.say(
      "We could not find an active paid session for this call. Please return to the main intake line."
    );
    response.hangup();
    res.type("text/xml");
    return res.send(response.toString());
  }

  payment.liveCallSid = callSid;
  payment.liveQueuedAt = new Date().toISOString();

  console.log("QUEUING CALL INTO FLEX:", { from, callSid });

  // Enqueue the live call into TaskRouter/Flex
const enqueue = response.enqueue({
  workflowSid: process.env.TWILIO_WORKFLOW_SID,
  waitUrl: `${process.env.BASE_URL}/twilio/hold-music`,
  waitUrlMethod: "POST",
  action: `${process.env.BASE_URL}/twilio/queue-fallback`,
  method: "POST",
  timeout: 20
});

const activeSessionId =
  payment.sessionId ||
  `lyvvout_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

payment.sessionId = activeSessionId;

payment.liveCallSid = callSid;
payment.liveQueuedAt = payment.liveQueuedAt || new Date().toISOString();

payment.callerPhone = payment.customerPhone || from;
payment.sessionLengthMinutes = 15;
payment.totalSessionSeconds = payment.totalSessionSeconds || 900;

payment.sessionLabel =
  payment.sessionLabel ||
  payment.sessionType ||
  "LyvvOut Session";

console.log("ENQUEUING FLEX TASK WITH ATTRIBUTES:", {
  activeSessionId,
  from,
  callSid,
  sessionType: payment.sessionType,
  sessionLabel: payment.sessionLabel,
  totalSessionSeconds: payment.totalSessionSeconds
});

const savedCallerName =
  payment.callerName ||
  payment.customerName ||
  payment.name ||
  payment.displayName ||
  pendingCallerNames.get(payment.blandCallId) ||
  pendingCallerNames.get(payment.callId) ||
  pendingCallerNames.get(payment.customerPhone) ||
  pendingCallerNames.get(payment.phone) ||
  pendingCallerNames.get(payment.callerPhone) ||
  pendingCallerNames.get(from) ||
  req.body.callerName ||
  req.body.caller_name ||
  req.body.customerName ||
  req.body.customer_name ||
  req.body.name ||
  "Not provided";

payment.callerName = savedCallerName;
payment.customerName = savedCallerName;
payment.displayName = savedCallerName;

payment.callerName = savedCallerName;
payment.customerName = savedCallerName;

console.log("FINAL FLEX CALLER DATA:", {
  callerName: payment.callerName,
  customerName: payment.customerName,
  sessionType: payment.sessionType,
  selectedPersona: payment.selectedPersona,
  sessionLabel: payment.sessionLabel,
  activeSessionId
});
console.log("SENDING FINAL TASK ATTRIBUTES TO FLEX:", {
  activeSessionId,
  callerName: payment.callerName,
  customerName: payment.customerName,
  callerPhone: payment.customerPhone || from,
  sessionType: payment.sessionType,
  selectedPersona: payment.selectedPersona,
  sessionLabel: payment.sessionLabel
});

enqueue.task(
  {
    priority: "1"
  },
  JSON.stringify({
    type: "lyvvout_live_session",
    direction: "inbound",
    lyvvout_session: true,

    sessionId: activeSessionId,
    activeSessionId: activeSessionId,

    from: payment.customerPhone || from,
    caller: payment.customerPhone || from,
    callerPhone: payment.customerPhone || from,
    customerPhone: payment.customerPhone || from,
    caller_phone: payment.customerPhone || from,
    caller_number: payment.customerPhone || from,
    customer_number: payment.customerPhone || from,

    name: payment.callerName || payment.customerName || savedCallerName || "Not provided",
    callerName: payment.callerName || payment.customerName || savedCallerName || "Not provided",
    customerName: payment.customerName || payment.callerName || savedCallerName || "Not provided",
    caller_name: payment.callerName || payment.customerName || savedCallerName || "Not provided",
    customer_name: payment.customerName || payment.callerName || savedCallerName || "Not provided",
    displayName: payment.callerName || payment.customerName || savedCallerName || "Not provided",

    sessionType: payment.sessionType || payment.selectedPersona || "Not provided",
    selectedPersona: payment.selectedPersona || payment.sessionType || "Not provided",
    sessionLabel: payment.sessionLabel || payment.sessionType || payment.selectedPersona || "LyvvOut Session",

    session_type: payment.sessionType || payment.selectedPersona || "Not provided",
    selected_persona: payment.selectedPersona || payment.sessionType || "Not provided",
    session_label: payment.sessionLabel || payment.sessionType || payment.selectedPersona || "LyvvOut Session",

    session_minutes: 15,
    session_seconds: payment.totalSessionSeconds || 900,
    totalSessionSeconds: payment.totalSessionSeconds || 900,

    paid: true,

    callSid: callSid,
    liveCallSid: callSid,

    taskQueueSid: "WQ03762702dcdf88a22fa5587014a64622"
  })
);

  res.type("text/xml");
  return res.send(response.toString());
});

// Hold music while caller waits in queue

app.post("/twilio/hold-music", (req, res) => {
  const VoiceResponse = require("twilio").twiml.VoiceResponse;
  const response = new VoiceResponse();

  const queueTime = parseInt(req.body.QueueTime || "0", 10);

  console.log("Hold music waitUrl hit:", {
    CallSid: req.body.CallSid,
    QueueSid: req.body.QueueSid,
    QueueTime: queueTime,
    QueuePosition: req.body.QueuePosition,
    CurrentQueueSize: req.body.CurrentQueueSize
  });

  const holdMusicUrl =
    process.env.TWILIO_HOLD_MUSIC_URL ||
    "https://lyvvout-assets-2042.twil.io/hold_music_short.mp3";

  response.play(
    { loop: 1 },
    holdMusicUrl
  );

  console.log("FORCING QUEUE LEAVE TO AI FALLBACK AFTER HOLD MUSIC:", {
    CallSid: req.body.CallSid,
    QueueSid: req.body.QueueSid,
    QueueTime: queueTime,
    holdMusicUrl
  });

  response.leave();

  res.type("text/xml");
  return res.send(response.toString());
});

app.post("/twilio/queue-fallback", (req, res) => {
  const twilio = require("twilio");
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const queueResult = String(req.body.QueueResult || "").toLowerCase();
  const queueTime = parseInt(req.body.QueueTime || "0", 10);
  const callSid = req.body.CallSid || "";
  const from = normalizePhone(req.body.From || "");

  console.log("QUEUE FALLBACK ACTION HIT:", {
    QueueResult: req.body.QueueResult,
    QueueTime: req.body.QueueTime,
    QueueSid: req.body.QueueSid,
    CallSid: callSid,
    From: from,
    To: req.body.To
  });

 let payment =
  payments.get(from) ||
  payments.get(callSid) ||
  [...payments.values()].find((p) => {
    return (
      p &&
      p.paid === true &&
      p.sessionComplete !== true &&
      (
        normalizePhone(p.customerPhone) === from ||
        normalizePhone(p.phone) === from ||
        normalizePhone(p.callerPhone) === from ||
        p.liveCallSid === callSid ||
        p.callId === callSid ||
        normalizePhone(p.callId) === from
      )
    );
  });

if (!payment) {
  payment = findMostRecentFallbackPayment() || findMostRecentActivePaidPayment();

  if (payment) {
    console.log("QUEUE FALLBACK PAYMENT RECOVERED USING ACTIVE SESSION:", {
      twilioFrom: from,
      callSid,
      recoveredCustomerPhone: payment.customerPhone,
      recoveredSessionType: payment.sessionType,
      paidAt: payment.paidAt
    });
  }
}

  const liveSessionAlreadyStarted =
    payment &&
    (
      payment.timerStarted === true ||
      !!payment.liveSessionStartedAt ||
      payment.liveSessionActive === true
    );

  console.log("QUEUE FALLBACK PAYMENT CHECK:", {
    foundPayment: !!payment,
    liveSessionAlreadyStarted,
    queueResult,
    queueTime,
    liveCallSid: payment?.liveCallSid || null,
    sessionId: payment?.sessionId || null
  });

  const liveHandledResults = [
    "bridged",
    "bridging-in-process",
    "completed"
  ];

  if (liveHandledResults.includes(queueResult) || liveSessionAlreadyStarted) {
    console.log("QUEUE ENDED AFTER LIVE LISTENER CONNECTION - NO AI FALLBACK:", {
      queueResult,
      queueTime,
      liveSessionAlreadyStarted
    });

    res.type("text/xml");
    return res.send(response.toString());
  }

const shouldFallback =
  queueResult === "timeout" ||
  queueResult === "queue-full" ||
  queueResult === "system-error" ||
  queueResult === "error" ||
  queueResult === "redirected" ||
  (
    queueResult === "leave" &&
    !liveSessionAlreadyStarted
  );

  if (!shouldFallback) {
    console.log("QUEUE ENDED WITHOUT FALLBACK:", {
      queueResult,
      queueTime,
      reason: "Queue result did not meet fallback conditions."
    });

    res.type("text/xml");
    return res.send(response.toString());
  }

  if (payment) {
    payment.queueFallbackTriggeredAt = new Date().toISOString();
    payment.queueFallbackReason = queueResult || "queue_timeout";
    payment.liveSessionActive = false;
    payment.fallbackRequested = true;
  }

  console.log("QUEUE DID NOT CONNECT - ROUTING TO AI FALLBACK:", {
    queueResult,
    queueTime,
    from,
    callSid
  });

  response.redirect(
    { method: "POST" },
    `${process.env.BASE_URL}/twilio/bland-fallback-entry`
  );

  res.type("text/xml");
  return res.send(response.toString());
});

app.post("/twilio/bland-fallback-entry", (req, res) => {
  const VoiceResponse = require("twilio").twiml.VoiceResponse;
  const response = new VoiceResponse();

  const from = normalizePhone(req.body.From || "");
  const callSid = req.body.CallSid || "";

  console.log("TWILIO BLAND FALLBACK ENTRY HIT:", {
    CallSid: callSid,
    From: from,
    To: req.body.To
  });

let payment =
  payments.get(from) ||
  payments.get(callSid) ||
  [...payments.values()].find((p) => {
    return (
      p &&
      p.paid === true &&
      p.sessionComplete !== true &&
      (
        normalizePhone(p.customerPhone) === from ||
        normalizePhone(p.phone) === from ||
        normalizePhone(p.callerPhone) === from ||
        p.liveCallSid === callSid ||
        p.callId === callSid ||
        normalizePhone(p.callId) === from
      )
    );
  });

if (!payment) {
  payment = findMostRecentFallbackPayment() || findMostRecentActivePaidPayment();

  if (payment) {
    console.log("BLAND FALLBACK ENTRY PAYMENT RECOVERED USING ACTIVE SESSION:", {
      twilioFrom: from,
      callSid,
      recoveredCustomerPhone: payment.customerPhone,
      recoveredSessionType: payment.sessionType,
      paidAt: payment.paidAt
    });
  }
}

if (payment) {
  payment.fallbackEntryHitAt = new Date().toISOString();
  payment.fallbackTwilioCallSid = callSid;
  payment.liveSessionActive = false;
  payment.fallbackRequested = true;
  payment.source = "twilio_queue_fallback";
  payment.updatedAt = new Date().toISOString();

  if (from) {
    payment.callerPhone = payment.callerPhone || from;
  }
}

  const blandFallbackNumber = process.env.BLAND_FALLBACK_PHONE_NUMBER;

  if (!blandFallbackNumber) {
    console.error("MISSING BLAND_FALLBACK_PHONE_NUMBER ENV VARIABLE");

    response.say(
      { voice: "Polly.Joanna" },
      "I am sorry. We were unable to connect you to a listener. Please call LyvvOut again."
    );
    response.hangup();

    res.type("text/xml");
    return res.send(response.toString());
  }

  response.say(
    { voice: "Polly.Joanna" },
    "Thank you for holding. I am connecting you to your listener now."
  );

  const dial = response.dial({
    answerOnBridge: true,
    timeout: 20
  });

  dial.number(blandFallbackNumber);

  console.log("DIALING BLAND FALLBACK NUMBER:", {
    from,
    callSid,
    blandFallbackNumber,
    foundPayment: !!payment
  });

  res.type("text/xml");
  return res.send(response.toString());
});

app.post("/bland/ai-fallback-transfer", (req, res) => {
  console.log("Bland AI fallback transfer webhook hit:", {
    body: req.body,
    query: req.query
  });

  res.status(200).json({
    success: true,
    route: "ai_fallback_transfer",
    message:
      "Thank you for holding. All of our listeners are currently with other clients. We will connect you shortly to another dedicated listener.",
    next_action: "AI_FALLBACK_TRANSFER",
    should_continue: true
  });
});

app.post("/twilio/assignment-callback", async (req, res) => {
  console.log("TASKROUTER ASSIGNMENT CALLBACK RECEIVED - NO AUTO DEQUEUE:", req.body);

  return res.status(200).json({});
});

app.post("/flex/start-live-session", (req, res) => {
  const {
    sessionId,
    liveCallSid,
    flexTaskSid,
    listenerName,
    listenerWorkerSid
  } = req.body;

 const payment = findPaymentForFlexStart({
  sessionId,
  liveCallSid
});

  if (!payment) {
    return res.status(404).json({
      ok: false,
      error: "No matching live session found"
    });
  }

  const activeSessionId =
  payment.sessionId ||
  `lyvvout_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

payment.sessionId = activeSessionId;
payment.activeSessionId = activeSessionId;

  if (payment.sessionComplete === true) {
    return res.status(400).json({
      ok: false,
      error: "Session is already complete"
    });
  }

  payment.flexTaskSid = flexTaskSid || payment.flexTaskSid || null;
  payment.listenerName = listenerName || payment.listenerName || null;
  payment.listenerWorkerSid = listenerWorkerSid || payment.listenerWorkerSid || null;

  if (payment.timerStarted === true) {
    return res.json({
      ok: true,
      message: "Timer already started",
      liveSessionStartedAt: payment.liveSessionStartedAt,
      liveSessionEndsAt: payment.liveSessionEndsAt,
      remainingSeconds: getLiveRemainingSeconds(payment)
    });
  }

  const now = new Date();

 payment.timerStarted = true;
payment.liveSessionActive = true;
payment.liveSessionStartedAt = now.toISOString();
payment.sessionStartedAt = now.toISOString();
payment.liveSessionEndsAt = new Date(
  now.getTime() + payment.totalSessionSeconds * 1000
).toISOString();

  payment.currentPrompt = "LIVE SESSION STARTED";
  payment.currentPromptScript =
    "The live listener has accepted the call. Paid session time has started.";

  payment.updatedAt = new Date().toISOString();

  console.log("LIVE LISTENER ACCEPTED - TIMER STARTED:", {
  activeSessionId: payment.sessionId,
  liveCallSid: payment.liveCallSid,
  flexTaskSid: payment.flexTaskSid,
  listenerName: payment.listenerName,
  sessionSeconds: payment.totalSessionSeconds,
  liveSessionStartedAt: payment.liveSessionStartedAt,
  liveSessionEndsAt: payment.liveSessionEndsAt
});

scheduleLiveSessionEndOnly(payment);

return res.json({
  ok: true,
  message: "Live session timer started",
  activeSessionId: payment.sessionId,
  callerName: payment.callerName,
  callerPhone: payment.customerPhone || payment.phone,
  sessionType: payment.sessionType,
  sessionLabel: payment.sessionLabel,
  sessionLengthMinutes: payment.sessionLengthMinutes,
  totalSessionSeconds: payment.totalSessionSeconds,
  liveSessionStartedAt: payment.liveSessionStartedAt,
  liveSessionEndsAt: payment.liveSessionEndsAt,
  remainingSeconds: getLiveRemainingSeconds(payment),
  currentPrompt: payment.currentPrompt,
  currentPromptScript: payment.currentPromptScript
});
});

app.get("/flex/session/:activeSessionId", (req, res) => {
  const { activeSessionId } = req.params;

  const payment = findPaymentForFlexStart({ activeSessionId });

  if (!payment) {
    return res.status(404).json({
      ok: false,
      error: "No matching session found"
    });
  }

  return res.json({
    ok: true,

    sessionId: payment.sessionId,

    callerName: payment.callerName || "Caller",
    callerPhone: payment.customerPhone || payment.phone || "",

    sessionType: payment.sessionType || "",
    sessionLabel: payment.sessionLabel || "",
    sessionLengthMinutes: payment.sessionLengthMinutes || null,

    paymentStatus: payment.paymentStatus || (payment.paid ? "paid" : "unpaid"),
    paid: payment.paid === true,

    intakeSummary: payment.intakeSummary || "",
    callerNeed: payment.callerNeed || "",
    callerMood: payment.callerMood || "",
    preferredTone: payment.preferredTone || "",
    listenerInstructions: payment.listenerInstructions || "",

    liveQueuedAt: payment.liveQueuedAt || null,
    timerStarted: payment.timerStarted === true,
    liveSessionActive: payment.liveSessionActive === true,
    liveSessionStartedAt: payment.liveSessionStartedAt || null,
    liveSessionEndsAt: payment.liveSessionEndsAt || null,

    totalSessionSeconds: payment.totalSessionSeconds || 0,
    remainingSeconds: getLiveRemainingSeconds(payment),

    twoMinuteWarningSent: payment.twoMinuteWarningSent === true,

    currentPrompt: payment.currentPrompt || "",
    currentPromptScript: payment.currentPromptScript || "",

    lastPromptType: payment.lastPromptType || null,
    lastPromptAt: payment.lastPromptAt || null,

    listenerName: payment.listenerName || null,
    listenerWorkerSid: payment.listenerWorkerSid || null,

    sessionComplete: payment.sessionComplete === true,
    completedReason: payment.completedReason || null,
    completedAt: payment.completedAt || null
  });
});

function findPaymentForFlexStart({ sessionId, liveCallSid }) {
  const allPayments =
    payments instanceof Map ? Array.from(payments.values()) : payments;

  return allPayments.find(payment => {
    const sessionMatches =
      sessionId && payment.sessionId === sessionId;

    const callMatches =
      liveCallSid && payment.liveCallSid === liveCallSid;

    return sessionMatches || callMatches;
  });

}

function getLiveRemainingSeconds(payment) {
  if (!payment) return 0;

  if (!payment.timerStarted || !payment.liveSessionEndsAt) {
    return payment.totalSessionSeconds || 0;
  }

  const endsAt = new Date(payment.liveSessionEndsAt).getTime();
  const now = Date.now();

  return Math.max(0, Math.ceil((endsAt - now) / 1000));
}

function scheduleLiveSessionEndOnly(payment) {
  if (!payment) return;
  if (!payment.timerStarted) return;
  if (!payment.liveSessionEndsAt) return;
  if (payment.sessionComplete === true) return;
  if (!payment.liveCallSid) return;

  const now = Date.now();
  const endAt = new Date(payment.liveSessionEndsAt).getTime();
  const delay = endAt - now;

  if (delay <= 0) {
    endLiveSessionCall(payment.liveCallSid, "paid_time_expired");
    return;
  }

  console.log("LIVE SESSION END TIMER SCHEDULED:", {
    sessionId: payment.sessionId,
    liveCallSid: payment.liveCallSid,
    endInSeconds: Math.ceil(delay / 1000),
    liveSessionEndsAt: payment.liveSessionEndsAt
  });

  setTimeout(() => {
    endLiveSessionCall(payment.liveCallSid, "paid_time_expired");
  }, delay);
}

async function endLiveSessionCall(identifier, reason) {
  const payment =
    payments.get(identifier) ||
    [...payments.values()].find(p =>
      p.callId === identifier ||
      p.customerPhone === identifier ||
      p.phone === identifier ||
      p.callerPhone === identifier ||
      p.liveCallSid === identifier ||
      p.sessionId === identifier ||
      p.activeSessionId === identifier
    );

  if (!payment) {
    console.log("END LIVE SESSION: NO PAYMENT FOUND", { identifier, reason });
    return;
  }

  if (payment.sessionComplete === true) {
    console.log("END LIVE SESSION: ALREADY COMPLETE", {
      sessionId: payment.sessionId,
      liveCallSid: payment.liveCallSid
    });
    return;
  }

  payment.sessionComplete = true;
  payment.liveSessionActive = false;
  payment.currentPrompt = "SESSION COMPLETE";
  payment.currentPromptScript = "The paid session time has ended.";
  payment.completedReason = reason;
  payment.completedAt = new Date().toISOString();
  payment.updatedAt = new Date().toISOString();

  console.log("LIVE SESSION ENDING:", {
    sessionId: payment.sessionId,
    liveCallSid: payment.liveCallSid,
    reason
  });

  if (!payment.liveCallSid) {
    console.log("No liveCallSid found. Cannot end Twilio call.");
    return;
  }

  try {
    await twilioClient.calls(payment.liveCallSid).update({
      status: "completed"
    });

    console.log("TWILIO LIVE CALL ENDED:", {
      sessionId: payment.sessionId,
      liveCallSid: payment.liveCallSid,
      reason
    });

    try {
  await sendLiveListenerSurveySms(payment);
} catch (smsError) {
  console.error("LIVE LISTENER SURVEY SMS ERROR:", smsError);
}

  } catch (error) {
    console.error("FAILED TO END TWILIO LIVE CALL:", error.message);
  }
}
async function sendLiveListenerSurveySms(payment) {
  const to =
    payment.customerPhone ||
    payment.phone ||
    payment.callerPhone ||
    payment.caller_phone;

  if (!to) {
    console.warn("LIVE SURVEY SMS SKIPPED - NO CUSTOMER PHONE", payment);
    return { success: false, error: "Missing customer phone" };
  }

  if (payment.liveSurveySmsSent === true) {
    console.log("LIVE SURVEY SMS SKIPPED - ALREADY SENT", { to });
    return { success: true, already_sent: true };
  }

  const from =
    process.env.TWILIO_LIVE_LISTENER_NUMBER ||
    process.env.TWILIO_PHONE_NUMBER;

  const message =
    "LyvvOut: Thank you for sharing this space with us. Please take 20 seconds to share your experience: https://lyvvout.com/#survey";

  const sms = await twilioClient.messages.create({
    to,
    from,
    body: message
  });

  payment.liveSurveySmsSent = true;
  payment.liveSurveySmsSid = sms.sid;
  payment.liveSurveySmsSentAt = new Date().toISOString();

  console.log("LIVE LISTENER SURVEY SMS SENT:", {
    to,
    from,
    sid: sms.sid
  });

  return { success: true, sid: sms.sid };
}

app.post("/send-payment-sms", async (req, res) => {
  try {
    console.log("PAYMENT SMS REQUEST:", req.body);

const rawPhone =
  req.body.phone_number ||
  req.body.phone ||
  req.body.from ||
  "";

const phone_number = normalizePhone(rawPhone);

if (!phone_number) {
      return res.status(400).json({
        success: false,
        error: "Missing phone_number"
      });
    }

    const message =
      "LyvvOut: Here is your secure payment link for your 15-minute LyvvOut session: https://lyvvout.com/#payment. Reply STOP to opt out. Reply HELP for help. Msg & data rates may apply.";

    const sms = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone_number
    });

    console.log("PAYMENT SMS SENT:", {
      to: phone_number,
      sid: sms.sid
    });

    return res.json({
      success: true,
      sid: sms.sid,
      message: "Payment SMS sent"
    });
  } catch (error) {
    console.error("PAYMENT SMS ERROR:", error);

    return res.status(500).json({
      success: false,
      error: "Failed to send payment SMS",
      details: error.message
    });
  }
});

app.post("/send-survey-sms", async (req, res) => {
  try {
    console.log("SURVEY SMS REQUEST:", req.body);

const rawSurveyPhone =
  req.body.phone_number ||
  req.body.phone ||
  req.body.from ||
  req.body.callerPhone ||
  req.body.customerPhone ||
  "";

const surveyCallId =
  req.body.call_id ||
  req.body.callId ||
  req.body.bland_call_id ||
  "";

let phone_number = normalizePhone(rawSurveyPhone);

if (!phone_number && surveyCallId) {
  const payment =
    payments.get(surveyCallId) ||
    [...payments.values()].find((p) =>
      p.callId === surveyCallId ||
      p.blandCallId === surveyCallId ||
      p.fallbackBlandCallId === surveyCallId ||
      p.sessionId === surveyCallId ||
      p.activeSessionId === surveyCallId
    );

  if (payment) {
    phone_number = normalizePhone(
      payment.customerPhone ||
      payment.phone ||
      payment.callerPhone ||
      ""
    );
  }
}

if (!phone_number) {
  return res.status(400).json({
    success: false,
    ok: false,
    error: "Missing phone_number"
  });
}

    const message =
      "LyvvOut: Thank you for calling. Please take 20 seconds to share your experience: https://lyvvout.com/#survey. Reply STOP to opt out. Reply HELP for help. Msg & data rates may apply.";

    const sms = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone_number
    });

    console.log("SURVEY SMS SENT:", {
      to: phone_number,
      sid: sms.sid
    });

  return res.json({
  success: true,
  ok: true,
  sid: sms.sid,
  survey_sms_sent: true,
  message: "Survey SMS sent"
});
  } catch (error) {
    console.error("SURVEY SMS ERROR:", error);

    return res.status(500).json({
      success: false,
      error: "Failed to send survey SMS",
      details: error.message
    });
  }
});


app.listen(PORT, () => {
  console.log(`LyvvOut webhook server running on port ${PORT}`);
});