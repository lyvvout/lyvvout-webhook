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
    price: "14.99",
    seconds: 900,
  },

  "https://buy.stripe.com/test_aFadRa715deu0ug4aR3Ru00": {
    sessionLength: "15",
    price: "14.99",
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

        if (amount === 1499) matchedPlan = PAYMENT_LINKS["https://buy.stripe.com/aFadRa715deu0ug4aR3Ru00"];
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
      req.body.phone,
      req.body.from,
      req.body.customerPhone,
      req.body.customer_phone,
      req.body.callerPhone,
      req.body.caller_number
    );

    const phone = normalizePhone(rawPhone);

    const callId = pickRealValue(
      req.body.call_id,
      req.body.callId,
      req.body.bland_call_id,
      req.body.fallback_bland_call_id,
      req.body.live_call_sid
    );

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
            p.fallbackBlandCallId === callId ||
            p.liveCallSid === callId ||
            p.fallbackTwilioCallSid === callId
          )
        );
      });

    if (!payment) {
      payment = findMostRecentFallbackPayment() || findMostRecentActivePaidPayment();
    }

    const toPhone = normalizePhone(
      payment?.customerPhone ||
      payment?.phone ||
      payment?.callerPhone ||
      phone
    );

    if (!toPhone || isTemplateValue(toPhone)) {
      console.log("SURVEY SMS SKIPPED - NO REAL PHONE:", {
        rawPhone,
        phone,
        callId,
        foundPayment: !!payment
      });

      return res.status(400).json({
        ok: false,
        sent: false,
        message: "No valid phone number available for survey SMS."
      });
    }

    if (payment?.surveySmsSent === true) {
      console.log("SURVEY SMS SKIPPED - ALREADY SENT:", {
        toPhone,
        customerPhone: payment.customerPhone
      });

      return res.json({
        ok: true,
        sent: true,
        already_sent: true,
        sid: payment.surveySmsSid || null,
        phone_number: toPhone,
        message: "Survey SMS already sent."
      });
    }

    const surveyText =
      "Thank you for using LyvvOut. Please take a quick moment to complete your session survey: https://lyvvout.com/#survey";

    const msg = await twilioClient.messages.create({
      to: toPhone,
      from: process.env.TWILIO_PHONE_NUMBER,
      body: surveyText
    });

  if (payment) {
  payment.surveySmsSent = true;
  payment.surveySmsSentAt = new Date().toISOString();

  payment.surveyReminderSent = true;
  payment.surveyDue = false;

  payment.surveySmsSid = msg.sid;

  payment.completedReason =
    payment.completedReason || "survey_sent";

  payment.updatedAt = new Date().toISOString();
}

 console.log("SURVEY SMS SENT:", {
  to: toPhone,
  sid: msg.sid,
  surveySmsSent: true,
  surveyReminderSent: true
});

    return res.json({
      ok: true,
      sent: true,
      sid: msg.sid,
      phone_number: toPhone,
      message: "Survey SMS sent."
    });
  } catch (error) {
    console.error("SURVEY SMS ERROR:", error);

    return res.status(500).json({
      ok: false,
      sent: false,
      message: "Survey SMS failed.",
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`LyvvOut webhook server running on port ${PORT}`);
});