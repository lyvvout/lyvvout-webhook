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
  "https://buy.stripe.com/3cIbJ20CH8Yedh29vb3Ru01": {
    sessionLength: "30",
    price: "49",
    seconds: 1800,
  },
  "https://buy.stripe.com/fZu7sM5X1eiyel622J3Ru02": {
    sessionLength: "60",
    price: "99",
    seconds: 3600,
  },
  "https://buy.stripe.com/5kQaEY859caq6SEbDj3Ru03": {
    sessionLength: "15",
    price: "20",
    seconds: 900,
    upsell: true,
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
          upsell: session.metadata.upsell === "true",
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
        if (amount === 4900) matchedPlan = PAYMENT_LINKS["https://buy.stripe.com/3cIbJ20CH8Yedh29vb3Ru01"];
        if (amount === 9900) matchedPlan = PAYMENT_LINKS["https://buy.stripe.com/fZu7sM5X1eiyel622J3Ru02"];
        if (amount === 2000) matchedPlan = PAYMENT_LINKS["https://buy.stripe.com/5kQaEY859caq6SEbDj3Ru03"];
      }

      const now = new Date();

const sessionSeconds =
  matchedPlan?.seconds ||
  Number(session.metadata?.seconds) ||
  900;

const isUpsell = matchedPlan?.upsell === true || session.metadata?.upsell === "true";

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
  sessionStartedAt: now.toISOString(),
  sessionSeconds,
  upsellSecondsAdded: isUpsell ? 900 : 0,
  totalSessionSeconds: sessionSeconds + (isUpsell ? 900 : 0),

  fiveMinuteWarningSent: false,
  twoMinuteWarningSent: false,
  wrapUpSent: false,
  sessionComplete: false,
};

payments.set(callId, paymentRecord);

if (paymentRecord.customerPhone) {
  payments.set(paymentRecord.customerPhone, paymentRecord);
}

if (paymentRecord.callId) {
  payments.set(paymentRecord.callId, paymentRecord);
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

// Bland AI calls this after caller presses 1.
app.post("/bland/check-payment", async (req, res) => {
  console.log("CHECK PAYMENT REQUEST BODY:", req.body);

  const normalizePhone = (value) => {
    if (!value) return "";
    const digits = String(value).replace(/\D/g, "");

    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

    return String(value).trim();
  };

  const rawPhone = req.body.phone || req.body.from || "";
  const phone = normalizePhone(rawPhone);

  const callId =
    req.body.call_id ||
    req.body.callId ||
    req.body.client_reference_id ||
    "";

  const normalizedCallId = normalizePhone(callId);

  console.log("NORMALIZED CHECK VALUES:", {
    rawPhone,
    phone,
    callId,
    normalizedCallId,
  });

  const payment =
    payments.get(phone) ||
    payments.get(callId) ||
    payments.get(normalizedCallId) ||
    [...payments.values()].find((p) => {
      return (
        p.paid === true &&
        (
          normalizePhone(p.customerPhone) === phone ||
          normalizePhone(p.phone) === phone ||
          p.callId === callId ||
          normalizePhone(p.callId) === normalizedCallId ||
          normalizePhone(p.callId) === phone
        )
      );
    });

  console.log("PAYMENT LOOKUP RESULT:", payment || "NO PAYMENT FOUND");

  if (!payment || payment.paid !== true) {
    return res.json({
      paid: false,
      paymentStatus: "not_found",
      message:
        "Payment has not been confirmed yet. Ask the caller to complete payment and press 1 again.",
    });
  }

  return res.json({
    paid: true,
    paymentStatus: "paid",
    message: "Payment confirmed. Continue the call.",
    call_id: payment.callId || callId || null,
    customerPhone: payment.customerPhone || payment.phone || phone,
    session_length: payment.plan?.sessionLength || null,
    session_seconds: payment.plan?.seconds || null,
    upsell: payment.plan?.upsell || false,
    stripe_session_id: payment.stripeSessionId || null,
  });
});

app.post("/bland/session-status", async (req, res) => {
  console.log("SESSION STATUS REQUEST BODY:", req.body);

  const normalizePhone = (value) => {
    if (!value) return "";
    const digits = String(value).replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return String(value).trim();
  };

  const rawPhone = req.body.phone || req.body.from || "";
  const phone = normalizePhone(rawPhone);

  const callId =
    req.body.call_id ||
    req.body.callId ||
    req.body.client_reference_id ||
    "";

  const normalizedCallId = normalizePhone(callId);

  const payment =
    payments.get(phone) ||
    payments.get(callId) ||
    payments.get(normalizedCallId) ||
    [...payments.values()].find((p) => {
      return (
        p.paid === true &&
        (
          normalizePhone(p.customerPhone) === phone ||
          normalizePhone(p.phone) === phone ||
          p.callId === callId ||
          normalizePhone(p.callId) === normalizedCallId ||
          normalizePhone(p.callId) === phone
        )
      );
    });

  if (!payment || payment.paid !== true) {
    return res.json({
      active: false,
      paid: false,
      remaining_seconds: 0,
      five_minute_warning_due: false,
      two_minute_warning_due: false,
      wrap_up_due: false,
      session_complete: false,
      message: "No active paid session found.",
    });
  }

  const now = Date.now();
  const startedAt = new Date(payment.sessionStartedAt || payment.paidAt).getTime();
  const totalSessionSeconds =
    payment.totalSessionSeconds ||
    payment.sessionSeconds ||
    payment.plan?.seconds ||
    900;

  const elapsedSeconds = Math.floor((now - startedAt) / 1000);
  const remainingSeconds = Math.max(totalSessionSeconds - elapsedSeconds, 0);

  const fiveMinuteWarningDue =
    remainingSeconds <= 300 &&
    remainingSeconds > 120 &&
    payment.fiveMinuteWarningSent !== true;

  const twoMinuteWarningDue =
    remainingSeconds <= 120 &&
    remainingSeconds > 30 &&
    payment.twoMinuteWarningSent !== true;

  const wrapUpDue =
    remainingSeconds <= 30 &&
    remainingSeconds > 0 &&
    payment.wrapUpSent !== true;

  const sessionComplete = remainingSeconds <= 0;

  if (fiveMinuteWarningDue) payment.fiveMinuteWarningSent = true;
  if (twoMinuteWarningDue) payment.twoMinuteWarningSent = true;
  if (wrapUpDue) payment.wrapUpSent = true;
  if (sessionComplete) payment.sessionComplete = true;

  console.log("SESSION STATUS RESULT:", {
    callId,
    phone,
    elapsedSeconds,
    remainingSeconds,
    totalSessionSeconds,
    fiveMinuteWarningDue,
    twoMinuteWarningDue,
    wrapUpDue,
    sessionComplete,
  });

  return res.json({
    active: !sessionComplete,
    paid: true,
    call_id: payment.callId || callId || null,
    remaining_seconds: remainingSeconds,
    elapsed_seconds: elapsedSeconds,
    total_session_seconds: totalSessionSeconds,
    five_minute_warning_due: fiveMinuteWarningDue,
    two_minute_warning_due: twoMinuteWarningDue,
    wrap_up_due: wrapUpDue,
    session_complete: sessionComplete,
    upsell_available: payment.plan?.upsell !== true,
    message: sessionComplete
      ? "Session complete."
      : "Session is active.",
  });
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

 const from = normalizePhone(req.body.From);
const callSid = req.body.CallSid;

const payment =
  payments.get(from) ||
  payments.get(callSid) ||
  [...payments.values()].find((p) => {
    return (
      p.paid === true &&
      (
        normalizePhone(p.customerPhone) === from ||
        normalizePhone(p.phone) === from ||
        p.callId === callSid ||
        normalizePhone(p.callId) === from
      )
    );
  });

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
payment.liveSessionStartedAt = null;
payment.liveSessionActive = false;
payment.timerStarted = false;

console.log("LIVE SESSION QUEUED:", {
  from,
  callSid,
  sessionSeconds: payment.totalSessionSeconds,
});

const flowUrl = `https://webhooks.twilio.com/v1/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Flows/FW8520122a6851630c570483753b160ac6`;

response.redirect(flowUrl);

res.type("text/xml");
return res.send(response.toString());
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
  payment.liveSessionEndsAt = new Date(
    now.getTime() + payment.totalSessionSeconds * 1000
  ).toISOString();

  payment.currentPrompt = "LIVE SESSION STARTED";
  payment.currentPromptScript =
    "The live listener has accepted the call. Paid session time has started.";

  payment.updatedAt = new Date().toISOString();

  console.log("LIVE LISTENER ACCEPTED - TIMER STARTED:", {
    sessionId: payment.sessionId,
    liveCallSid: payment.liveCallSid,
    flexTaskSid: payment.flexTaskSid,
    listenerName: payment.listenerName,
    sessionSeconds: payment.totalSessionSeconds,
    liveSessionStartedAt: payment.liveSessionStartedAt,
    liveSessionEndsAt: payment.liveSessionEndsAt
  });

  scheduleLiveSessionTimers(payment);

  return res.json({
    ok: true,
    message: "Live session timer started",
    sessionId: payment.sessionId,
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

app.get("/flex/session/:sessionId", (req, res) => {
  const { sessionId } = req.params;

  const payment = findPaymentForFlexStart({ sessionId });

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

    fiveMinuteWarningSent: payment.fiveMinuteWarningSent === true,
    twoMinuteWarningSent: payment.twoMinuteWarningSent === true,
    wrapUpSent: payment.wrapUpSent === true,

    currentPrompt: payment.currentPrompt || "",
    currentPromptScript: payment.currentPromptScript || "",

    upsellOfferActive: payment.upsellOfferActive === true,
    upsellPaymentPending: payment.upsellPaymentPending === true,
    upsellPaymentComplete: payment.upsellPaymentComplete === true,

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

function scheduleLiveSessionTimers(payment) {
  if (!payment) return;
  if (!payment.sessionId) return;
  if (!payment.timerStarted) return;
  if (!payment.liveSessionEndsAt) return;
  if (payment.sessionComplete === true) return;

  const now = Date.now();
  const endAt = new Date(payment.liveSessionEndsAt).getTime();

  const fiveMinuteAt = endAt - 5 * 60 * 1000;
  const twoMinuteAt = endAt - 2 * 60 * 1000;
  const wrapUpAt = endAt - 30 * 1000;

  console.log("LIVE SESSION TIMERS SCHEDULED:", {
    sessionId: payment.sessionId,
    liveCallSid: payment.liveCallSid,
    remainingSeconds: getLiveRemainingSeconds(payment),
    liveSessionEndsAt: payment.liveSessionEndsAt,
    fiveMinuteInSeconds: Math.max(0, Math.ceil((fiveMinuteAt - now) / 1000)),
    twoMinuteInSeconds: Math.max(0, Math.ceil((twoMinuteAt - now) / 1000)),
    wrapUpInSeconds: Math.max(0, Math.ceil((wrapUpAt - now) / 1000)),
    endInSeconds: Math.max(0, Math.ceil((endAt - now) / 1000))
  });

  if (fiveMinuteAt > now && payment.fiveMinuteWarningSent !== true) {
    setTimeout(() => {
      fireLiveSessionPrompt(payment.sessionId, "five_minute_upsell");
    }, fiveMinuteAt - now);
  }

  if (twoMinuteAt > now && payment.twoMinuteWarningSent !== true) {
    setTimeout(() => {
      fireLiveSessionPrompt(payment.sessionId, "two_minute_warning");
    }, twoMinuteAt - now);
  }

  if (wrapUpAt > now && payment.wrapUpSent !== true) {
    setTimeout(() => {
      fireLiveSessionPrompt(payment.sessionId, "thirty_second_wrap_up");
    }, wrapUpAt - now);
  }

  if (endAt > now) {
    setTimeout(() => {
      endLiveSessionCall(payment.sessionId, "paid_time_expired");
    }, endAt - now);
  }
}

function fireLiveSessionPrompt(sessionId, promptType) {
  const payment = findPaymentForFlexStart({ sessionId });

  if (!payment) return;
  if (payment.sessionComplete === true) return;

  if (promptType === "five_minute_upsell") {
    if (payment.fiveMinuteWarningSent === true) return;

    payment.fiveMinuteWarningSent = true;
    payment.upsellOfferActive = true;
    payment.upsellPaymentPending = false;
    payment.upsellPaymentComplete = false;

    payment.currentPrompt = "5-MINUTE UPSELL";
    payment.currentPromptScript =
      "You have about five minutes remaining in your session. Would you like to add an additional 15 minutes?";
  }

  if (promptType === "two_minute_warning") {
    if (payment.twoMinuteWarningSent === true) return;

    payment.twoMinuteWarningSent = true;
    payment.upsellOfferActive = false;

    payment.currentPrompt = "2-MINUTE WARNING";
    payment.currentPromptScript =
      "You have about two minutes remaining, so we are going to begin gently wrapping up your session.";
  }

  if (promptType === "thirty_second_wrap_up") {
    if (payment.wrapUpSent === true) return;

    payment.wrapUpSent = true;
    payment.upsellOfferActive = false;

    payment.currentPrompt = "30-SECOND WRAP-UP";
    payment.currentPromptScript =
      "We are at the end of your session, so I am going to leave you with one final thought before the call closes.";
  }

  payment.lastPromptType = promptType;
  payment.lastPromptAt = new Date().toISOString();
  payment.updatedAt = new Date().toISOString();

  console.log("LIVE SESSION PROMPT FIRED:", {
    sessionId: payment.sessionId,
    promptType,
    currentPrompt: payment.currentPrompt,
    remainingSeconds: getLiveRemainingSeconds(payment)
  });
}

async function endLiveSessionCall(sessionId, reason) {
  const payment = findPaymentForFlexStart({ sessionId });

  if (!payment) return;
  if (payment.sessionComplete === true) return;

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
  } catch (error) {
    console.error("FAILED TO END TWILIO LIVE CALL:", error.message);
  }
}

app.post('/send-payment-sms', async (req, res) => {
  try {
    const { phone_number, session_length } = req.body;

    let message = '';

    if (session_length === 15) {
      message = 'LyvvOut: Here is your secure payment link for your Quick Break 15 minute session: https://buy.stripe.com/aFadRa715deu0ug4aR3Ru00 — By completing payment you agree to LyvvOut’s terms at lyvvout.com.';
    } 
    else if (session_length === 30) {
      message = 'LyvvOut: Here is your secure payment link for your Standard Session 30 minute session: https://buy.stripe.com/3cIbJ20CH8Yedh29vb3Ru01 — By completing payment you agree to LyvvOut’s terms at lyvvout.com.';
    } 
    else if (session_length === 60) {
      message = 'LyvvOut: Here is your secure payment link for your Deep Session 60 minute session: https://buy.stripe.com/fZu7sM5X1eiyel622J3Ru02 — By completing payment you agree to LyvvOut’s terms at lyvvout.com.';
    } 
    else {
      return res.status(400).json({ error: 'Invalid session length' });
    }

    const sms = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone_number
    });

    res.json({ success: true, sid: sms.sid });

  } catch (error) {
    console.error('SMS ERROR:', error);
    res.status(500).json({ error: 'Failed to send SMS' });
  }
});

app.listen(PORT, () => {
  console.log(`LyvvOut webhook server running on port ${PORT}`);
});