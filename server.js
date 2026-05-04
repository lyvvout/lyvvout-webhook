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

console.log("Payment confirmed:", paymentRecord);

      console.log("Payment confirmed:", payments.get(callId));
    }

    res.json({ received: true });
  }
);

// JSON routes after Stripe raw webhook
app.use(express.json());

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