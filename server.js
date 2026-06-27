require('dotenv').config();
const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");

// Twilio is kept ONLY as the SMS sender (payment link + survey link).
// The old Twilio voice IVR intake has been removed. ElevenLabs now handles
// the spoken intake. Twilio remains the phone carrier only.
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
// WARNING: a Render restart or redeploy erases everything here, which kills
// any call that is mid-session. Move this to a database before real launch.
const payments = new Map();
const pendingCallerNames = new Map();

function normalizePhone(value) {
  if (!value) return "";
  const digits = String(value).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return String(value).trim();
}

function formatPhoneForSpeech(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  const last10 = digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits;

  if (last10.length !== 10) return phone;

  return `${last10.slice(0, 3)}-${last10.slice(3, 6)}-${last10.slice(6)}`;
}

// Human-readable label for a session type code.
function formatSessionTypeLabel(value) {
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

// Accept the exact session type codes, plus a few defensive variants
// (digits 1-5, spaces instead of underscores). Returns "" if unrecognized.
function normalizeSessionType(value) {
  const raw = String(value || "").toLowerCase().trim().replace(/\s+/g, "_");

  const digitMap = {
    "1": "just_listen",
    "2": "react_with_me",
    "3": "hype_session",
    "4": "keep_it_real",
    "5": "no_filter"
  };

  if (digitMap[raw]) return digitMap[raw];

  const valid = [
    "just_listen",
    "react_with_me",
    "hype_session",
    "keep_it_real",
    "no_filter"
  ];

  return valid.includes(raw) ? raw : "";
}

// Accept female/male plus defensive variants. Returns "" if unrecognized.
function normalizeVoiceGender(value) {
  const raw = String(value || "").toLowerCase().trim();

  if (["1", "female", "f", "woman", "femenina", "mujer"].includes(raw)) {
    return "female";
  }

  if (["2", "male", "m", "man", "masculina", "hombre"].includes(raw)) {
    return "male";
  }

  return "";
}

// Return every distinct caller record that matches this phone, by any phone
// field OR by direct key. This is what lets us survive the fact that intake
// and the Stripe webhook can create two separate records for one caller.
function getAllCallerRecords(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return [];

  const all = [...new Set([...payments.values()])].filter((p) => {
    return (
      p &&
      (
        normalizePhone(p.customerPhone) === normalized ||
        normalizePhone(p.phone) === normalized ||
        normalizePhone(p.callerPhone) === normalized
      )
    );
  });

  const direct = payments.get(normalized);
  if (direct && !all.includes(direct)) all.push(direct);

  return all;
}

// First non-empty value of a field across a set of records.
function pickFirstDefined(records, field) {
  for (const r of records) {
    if (r && r[field] !== undefined && r[field] !== null && r[field] !== "") {
      return r[field];
    }
  }
  return undefined;
}

// The confirmed-paid record for a caller, most recent first.
function findPaidCallerRecord(phone) {
  const records = getAllCallerRecords(phone);

  const paid = records
    .filter((p) => p.paid === true)
    .sort((a, b) => {
      const aTime = new Date(a.updatedAt || a.paidAt || 0).getTime();
      const bTime = new Date(b.updatedAt || b.paidAt || 0).getTime();
      return bTime - aTime;
    });

  return paid[0] || null;
}

// Write the same updates onto EVERY record that matches this phone, so intake
// and paid records stay in sync no matter which one a later tool resolves.
function applyToAllCallerRecords(phone, updates) {
  const records = getAllCallerRecords(phone);
  const now = new Date().toISOString();

  records.forEach((rec) => {
    Object.assign(rec, updates, { updatedAt: now });
  });

  const normalized = normalizePhone(phone);
  if (normalized && records.length > 0) {
    const paid = records.find((r) => r.paid === true);
    payments.set(normalized, paid || records[0]);
  }

  return records;
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

const PAYMENT_LINKS = {
  "https://buy.stripe.com/aFadRa715deu0ug4aR3Ru00": {
    sessionLength: "15",
    price: "19.99",
    seconds: 900,
  },

  "https://buy.stripe.com/test_aFadRa715deu0ug4aR3Ru00": {
    sessionLength: "15",
    price: "19.99",
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

        if (amount === 1499 || amount === 1999) {
          matchedPlan = PAYMENT_LINKS["https://buy.stripe.com/aFadRa715deu0ug4aR3Ru00"];
        }
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

      // Carry over anything the ElevenLabs intake captured before payment
      // (language, caller name) so the paid record is complete. The agent
      // selection later depends on language being present.
      const intakePhone = normalizePhone(paymentRecord.customerPhone || callId);
      const intakeRecords = getAllCallerRecords(intakePhone);
      const intakeRecord =
        intakeRecords.find((p) => p && p.source === "elevenlabs_intake") ||
        intakeRecords[0];

      if (intakeRecord) {
        if (!paymentRecord.language && intakeRecord.language) {
          paymentRecord.language = intakeRecord.language;
        }
        if (!paymentRecord.callerName && intakeRecord.callerName) {
          paymentRecord.callerName = intakeRecord.callerName;
          paymentRecord.customerName = intakeRecord.callerName;
          paymentRecord.displayName = intakeRecord.callerName;
        }
        if (!paymentRecord.voiceGender && intakeRecord.voiceGender) {
          paymentRecord.voiceGender = intakeRecord.voiceGender;
        }
        if (!paymentRecord.sessionType && intakeRecord.sessionType) {
          paymentRecord.sessionType = intakeRecord.sessionType;
        }
      }

      payments.set(callId, paymentRecord);

      if (paymentRecord.customerPhone) {
        payments.set(normalizePhone(paymentRecord.customerPhone), paymentRecord);
      }

      const pendingName =
        pendingCallerNames.get(normalizePhone(paymentRecord.customerPhone)) ||
        pendingCallerNames.get(callId) ||
        pendingCallerNames.get(normalizePhone(callId));

      if (pendingName && !paymentRecord.callerName) {
        paymentRecord.callerName = pendingName;
        paymentRecord.customerName = pendingName;
        paymentRecord.displayName = pendingName;

        console.log("PENDING CALLER NAME ATTACHED TO PAYMENT:", {
          phone: paymentRecord.customerPhone,
          callerName: pendingName
        });
      }

      console.log("Payment confirmed:", paymentRecord);
    }

    res.json({ received: true });
  }
);

// JSON routes after Stripe raw webhook
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/", (req, res) => {
  res.json({
    status: "LyvvOut webhook server running",
    health: "/health",
    stripeWebhook: "/stripe-webhook",
    intake: "/elevenlabs/save-intake-info",
    checkPayment: "/elevenlabs/check-payment",
    saveSessionType: "/elevenlabs/save-session-type",
    saveVoicePreference: "/elevenlabs/save-voice-preference",
    startPaidSession: "/elevenlabs/start-paid-session",
    startSessionTimer: "/elevenlabs/start-session-timer",
    checkSessionTime: "/elevenlabs/check-session-time",
    sendTwoMinuteWarning: "/elevenlabs/send-two-minute-warning",
    endSession: "/elevenlabs/end-session",
    sendPaymentSms: "/send-payment-sms",
    sendSurveySms: "/send-survey-sms"
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Temporary diagnostic. Reports which required env vars are SET (true/false),
// never their values, so nothing secret is exposed. Safe to delete after launch.
app.get("/env-check", (req, res) => {
  const isSet = (name) => !!process.env[name];
  res.json({
    twilio: {
      TWILIO_ACCOUNT_SID: isSet("TWILIO_ACCOUNT_SID"),
      TWILIO_AUTH_TOKEN: isSet("TWILIO_AUTH_TOKEN"),
      TWILIO_PHONE_NUMBER: isSet("TWILIO_PHONE_NUMBER")
    },
    stripe: {
      STRIPE_SECRET_KEY: isSet("STRIPE_SECRET_KEY"),
      STRIPE_WEBHOOK_SECRET: isSet("STRIPE_WEBHOOK_SECRET")
    },
    elevenlabs_paid_agents: {
      ELEVENLABS_AGENT_EN_FEMALE: isSet("ELEVENLABS_AGENT_EN_FEMALE"),
      ELEVENLABS_AGENT_EN_MALE: isSet("ELEVENLABS_AGENT_EN_MALE"),
      ELEVENLABS_AGENT_ES_FEMALE: isSet("ELEVENLABS_AGENT_ES_FEMALE"),
      ELEVENLABS_AGENT_ES_MALE: isSet("ELEVENLABS_AGENT_ES_MALE")
    }
  });
});

// =====================================================================
// PHASE 1 — INTAKE + PAYMENT
// =====================================================================

// 1. save_intake_info
app.post("/elevenlabs/save-intake-info", (req, res) => {
  try {
    console.log("ELEVENLABS SAVE INTAKE INFO REQUEST:", req.body);

    const rawPhone =
      req.body.phone_number ||
      req.body.phone ||
      req.body.customerPhone ||
      req.body.callerPhone ||
      "";

    const phone = normalizePhone(rawPhone);

    const callerName =
      String(
        req.body.callerName ||
        req.body.customerName ||
        req.body.name ||
        "Caller"
      ).trim();

    const language =
      String(req.body.language || "english").toLowerCase().includes("spanish")
        ? "spanish"
        : "english";

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "Missing phone number."
      });
    }

    const intakeId = `elevenlabs_${phone}_${Date.now()}`;

    const paymentRecord = {
      callId: intakeId,
      source: "elevenlabs_intake",
      paid: false,
      language,
      callerName,
      customerName: callerName,
      displayName: callerName,
      customerPhone: phone,
      phone,
      sessionComplete: false,
      timerStarted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    payments.set(intakeId, paymentRecord);
    payments.set(phone, paymentRecord);

    pendingCallerNames.set(phone, callerName);

    console.log("ELEVENLABS INTAKE SAVED:", {
      intakeId,
      phone,
      callerName,
      language
    });

    return res.json({
      ok: true,
      intakeId,
      phone,
      callerName,
      language,
      message: `Caller info saved for ${callerName}.`
    });
  } catch (error) {
    console.error("ELEVENLABS SAVE INTAKE INFO ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "Failed to save intake info.",
      details: error.message
    });
  }
});

// 2. send_payment_sms
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

// 3. check_payment
app.post("/elevenlabs/check-payment", (req, res) => {
  try {
    console.log("ELEVENLABS CHECK PAYMENT REQUEST:", req.body);

    const rawPhone =
      req.body.phone_number ||
      req.body.phone ||
      req.body.customerPhone ||
      req.body.callerPhone ||
      "";

    const phone = normalizePhone(rawPhone);

    if (!phone) {
      return res.status(400).json({
        ok: false,
        paid: false,
        error: "Missing phone number."
      });
    }

    const matches = getAllCallerRecords(phone);

    // Prefer a confirmed-paid record. The intake record (paid:false) and the
    // Stripe record (paid:true) can both exist for one phone, so we must not
    // just grab the first match.
    const payment =
      matches.find((p) => p.paid === true) ||
      payments.get(phone) ||
      matches[0];

    const language = pickFirstDefined(matches, "language") || "english";

    console.log("ELEVENLABS CHECK PAYMENT RESULT:", {
      phone,
      found: !!payment,
      paid: payment?.paid,
      customerPhone: payment?.customerPhone,
      paymentCallId: payment?.callId
    });

    if (payment?.paid === true) {
      return res.json({
        ok: true,
        paid: true,
        phone,
        callerName: payment.callerName || payment.customerName || "Caller",
        language,
        sessionLength: payment.plan?.sessionLength || payment.sessionLength || "15",
        sessionSeconds: payment.sessionSeconds || 900,
        message:
          language === "spanish"
            ? "Pago confirmado."
            : "Payment confirmed."
      });
    }

    return res.json({
      ok: true,
      paid: false,
      keepWaiting: true,
      phone,
      message:
        language === "spanish"
          ? "Aún estamos esperando la confirmación del pago."
          : "We are still waiting for payment confirmation."
    });
  } catch (error) {
    console.error("ELEVENLABS CHECK PAYMENT ERROR:", error);

    return res.status(500).json({
      ok: false,
      paid: false,
      error: "Failed to check payment.",
      details: error.message
    });
  }
});

// 4. save_session_type
app.post("/elevenlabs/save-session-type", (req, res) => {
  try {
    console.log("ELEVENLABS SAVE SESSION TYPE REQUEST:", req.body);

    const rawPhone =
      req.body.phone_number ||
      req.body.phone ||
      req.body.customerPhone ||
      req.body.callerPhone ||
      "";

    const phone = normalizePhone(rawPhone);

    const sessionType = normalizeSessionType(
      req.body.sessionType || req.body.session_type
    );

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "Missing phone number."
      });
    }

    if (!sessionType) {
      return res.status(400).json({
        ok: false,
        error: "Invalid or missing sessionType.",
        accepted: [
          "just_listen",
          "react_with_me",
          "hype_session",
          "keep_it_real",
          "no_filter"
        ]
      });
    }

    const records = applyToAllCallerRecords(phone, {
      sessionType,
      sessionTypeLabel: formatSessionTypeLabel(sessionType)
    });

    if (records.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "No caller record found for this phone. Run save_intake_info first."
      });
    }

    console.log("ELEVENLABS SESSION TYPE SAVED:", {
      phone,
      sessionType,
      recordsUpdated: records.length
    });

    return res.json({
      ok: true,
      sessionType,
      message: "Session type saved."
    });
  } catch (error) {
    console.error("ELEVENLABS SAVE SESSION TYPE ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "Failed to save session type.",
      details: error.message
    });
  }
});

// 5. save_voice_preference
app.post("/elevenlabs/save-voice-preference", (req, res) => {
  try {
    console.log("ELEVENLABS SAVE VOICE PREFERENCE REQUEST:", req.body);

    const rawPhone =
      req.body.phone_number ||
      req.body.phone ||
      req.body.customerPhone ||
      req.body.callerPhone ||
      "";

    const phone = normalizePhone(rawPhone);

    const voiceGender = normalizeVoiceGender(
      req.body.voiceGender || req.body.voice_gender || req.body.voice
    );

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "Missing phone number."
      });
    }

    if (!voiceGender) {
      return res.status(400).json({
        ok: false,
        error: "Invalid or missing voiceGender.",
        accepted: ["female", "male"]
      });
    }

    const records = applyToAllCallerRecords(phone, { voiceGender });

    if (records.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "No caller record found for this phone. Run save_intake_info first."
      });
    }

    console.log("ELEVENLABS VOICE PREFERENCE SAVED:", {
      phone,
      voiceGender,
      recordsUpdated: records.length
    });

    return res.json({
      ok: true,
      voiceGender,
      message: "Voice preference saved."
    });
  } catch (error) {
    console.error("ELEVENLABS SAVE VOICE PREFERENCE ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "Failed to save voice preference.",
      details: error.message
    });
  }
});

// 6. start_paid_session
app.post("/elevenlabs/start-paid-session", (req, res) => {
  try {
    console.log("ELEVENLABS START PAID SESSION REQUEST:", req.body);

    const rawPhone =
      req.body.phone_number ||
      req.body.phone ||
      req.body.customerPhone ||
      req.body.callerPhone ||
      "";

    const phone = normalizePhone(rawPhone);

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "Missing phone number."
      });
    }

    const records = getAllCallerRecords(phone);

    if (records.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "No caller record found for this phone."
      });
    }

    const paid = findPaidCallerRecord(phone);

    if (!paid) {
      return res.json({
        ok: false,
        paid: false,
        message: "Payment not confirmed. Cannot start paid session."
      });
    }

    const language = pickFirstDefined(records, "language") || "english";
    const voiceGender = pickFirstDefined(records, "voiceGender") || "female";
    const sessionType = pickFirstDefined(records, "sessionType") || "not_provided";

    // Each language+gender maps to a POOL of interchangeable agents that share
    // the same prompt and tools but use different primary voices. We pick one
    // at random so callers do not always hear the identical voice. To add or
    // remove a voice, just edit the lists below.
    const AGENT_POOLS = {
      spanish_female: [
        "agent_4401kvvrnmhhew7am47vxneh570e",
        "agent_2301kw5j7dddekv93pt6pdd9psjn",
        "agent_6901kw5jgwegffv8k2k42man68xs",
        "agent_9901kw5jnqbhegjbqpfr0pgsbk4m"
      ],
      spanish_male: [
        "agent_5501kvvrmmj9feva4bpy3ytqp3tn",
        "agent_8001kw5hk93sfd7tmfc7gzde219e",
        "agent_4901kw5hsbcmfnkrtg5y17ed8ser",
        "agent_0101kw5hwsktfeeb8yr4zf5f32mj"
      ],
      english_female: [
        "agent_9301kvvn3aeceexbj5860ne19mn6",
        "agent_9401kw5kh5chf1pb4hsgs642rcjr",
        "agent_9201kw5kkmqkefj8bnbefxms3ttv",
        "agent_1201kw5kp472ef6bm2fx4aswkagv"
      ],
      english_male: [
        "agent_4801kvvn6amhf079xsdpt76cmzfm",
        "agent_0801kw5k267zfyzt0qkfyfy3xt1a",
        "agent_7601kw5k4vz2ebxvtx8en57cghh8",
        "agent_0901kw5k71b6ew38d225vzfke322"
      ]
    };

    const poolKey = `${language === "spanish" ? "spanish" : "english"}_${voiceGender === "male" ? "male" : "female"}`;
    const pool = AGENT_POOLS[poolKey] || [];
    const agentId = pool[Math.floor(Math.random() * pool.length)];

    if (!agentId) {
      console.error("START PAID SESSION - MISSING AGENT ENV VAR:", {
        language,
        voiceGender
      });

      return res.status(500).json({
        ok: false,
        error: "Agent ID is not configured for this language and voice combination.",
        language,
        voiceGender
      });
    }

    applyToAllCallerRecords(phone, {
      paidSessionAgentId: agentId,
      paidSessionRequestedAt: new Date().toISOString()
    });

    console.log("ELEVENLABS START PAID SESSION SELECTED:", {
      phone,
      language,
      voiceGender,
      sessionType,
      agentId
    });

    return res.json({
      ok: true,
      agentId,
      language,
      voiceGender,
      sessionType,
      message: "Starting session."
    });
  } catch (error) {
    console.error("ELEVENLABS START PAID SESSION ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "Failed to start paid session.",
      details: error.message
    });
  }
});

// =====================================================================
// PHASE 2 — SESSION LIFECYCLE
// =====================================================================

// 7. start_session_timer
app.post("/elevenlabs/start-session-timer", (req, res) => {
  try {
    console.log("ELEVENLABS START SESSION TIMER REQUEST:", req.body);

    const rawPhone =
      req.body.phone_number ||
      req.body.phone ||
      req.body.customerPhone ||
      req.body.callerPhone ||
      "";

    const phone = normalizePhone(rawPhone);

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "Missing phone number."
      });
    }

    const paid = findPaidCallerRecord(phone);

    if (!paid) {
      return res.json({
        ok: false,
        paid: false,
        message: "Payment not confirmed. Timer not started."
      });
    }

    const sessionSeconds = paid.sessionSeconds || paid.totalSessionSeconds || 900;

    // The paid agent calls this as its first action, so we return the full
    // caller context. This is how the paid agent learns which persona to run
    // (sessionType) and which language to speak, with the backend as the
    // single source of truth instead of relying on transfer variables.
    const records = getAllCallerRecords(phone);
    const sessionContext = {
      callerName:
        pickFirstDefined(records, "callerName") ||
        pickFirstDefined(records, "customerName") ||
        "Caller",
      language: pickFirstDefined(records, "language") || "english",
      sessionType: pickFirstDefined(records, "sessionType") || "not_provided",
      voiceGender: pickFirstDefined(records, "voiceGender") || "female"
    };

    // Idempotent: never restart a clock that is already running.
    if (paid.timerStarted === true && paid.sessionStartedAt) {
      const startedAt = new Date(paid.sessionStartedAt).getTime();
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const secondsRemaining = Math.max(0, sessionSeconds - elapsed);

      return res.json({
        ok: true,
        alreadyStarted: true,
        sessionStartedAt: paid.sessionStartedAt,
        sessionSeconds,
        secondsRemaining,
        ...sessionContext,
        message: "Session timer already running."
      });
    }

    const startedAtIso = new Date().toISOString();

    applyToAllCallerRecords(phone, {
      timerStarted: true,
      sessionStartedAt: startedAtIso,
      sessionSeconds,
      totalSessionSeconds: paid.totalSessionSeconds || sessionSeconds,
      twoMinuteWarningSent: false,
      sessionComplete: false
    });

    console.log("ELEVENLABS SESSION TIMER STARTED:", {
      phone,
      startedAtIso,
      sessionSeconds
    });

    return res.json({
      ok: true,
      started: true,
      sessionStartedAt: startedAtIso,
      sessionSeconds,
      secondsRemaining: sessionSeconds,
      ...sessionContext,
      message: "Session timer started."
    });
  } catch (error) {
    console.error("ELEVENLABS START SESSION TIMER ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "Failed to start session timer.",
      details: error.message
    });
  }
});

// 8. check_session_time
app.post("/elevenlabs/check-session-time", (req, res) => {
  try {
    console.log("ELEVENLABS CHECK SESSION TIME REQUEST:", req.body);

    const rawPhone =
      req.body.phone_number ||
      req.body.phone ||
      req.body.customerPhone ||
      req.body.callerPhone ||
      "";

    const phone = normalizePhone(rawPhone);

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "Missing phone number."
      });
    }

    const paid = findPaidCallerRecord(phone);

    if (!paid) {
      return res.json({
        ok: false,
        paid: false,
        message: "Payment not confirmed."
      });
    }

    const sessionSeconds = paid.sessionSeconds || paid.totalSessionSeconds || 900;

    if (paid.timerStarted !== true || !paid.sessionStartedAt) {
      return res.json({
        ok: true,
        timerStarted: false,
        secondsRemaining: sessionSeconds,
        minutesRemaining: Math.ceil(sessionSeconds / 60),
        expired: false,
        twoMinuteWarningDue: false,
        message: "Timer has not started yet."
      });
    }

    const startedAt = new Date(paid.sessionStartedAt).getTime();
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const secondsRemaining = Math.max(0, sessionSeconds - elapsed);
    const expired = secondsRemaining <= 0;
    const twoMinuteWarningDue =
      secondsRemaining > 0 &&
      secondsRemaining <= 120 &&
      paid.twoMinuteWarningSent !== true;

    return res.json({
      ok: true,
      timerStarted: true,
      sessionStartedAt: paid.sessionStartedAt,
      sessionSeconds,
      elapsedSeconds: elapsed,
      secondsRemaining,
      minutesRemaining: Math.ceil(secondsRemaining / 60),
      expired,
      twoMinuteWarningDue,
      twoMinuteWarningSent: paid.twoMinuteWarningSent === true,
      sessionComplete: paid.sessionComplete === true,
      message: expired ? "Session time is up." : "Session time remaining."
    });
  } catch (error) {
    console.error("ELEVENLABS CHECK SESSION TIME ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "Failed to check session time.",
      details: error.message
    });
  }
});

// 9. send_two_minute_warning
// This does NOT send an SMS. It marks the warning as given so the agent
// only says it once, and returns shouldWarn telling the agent whether to
// speak the warning now.
app.post("/elevenlabs/send-two-minute-warning", (req, res) => {
  try {
    console.log("ELEVENLABS TWO MINUTE WARNING REQUEST:", req.body);

    const rawPhone =
      req.body.phone_number ||
      req.body.phone ||
      req.body.customerPhone ||
      req.body.callerPhone ||
      "";

    const phone = normalizePhone(rawPhone);

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "Missing phone number."
      });
    }

    const paid = findPaidCallerRecord(phone);

    if (!paid) {
      return res.json({
        ok: false,
        paid: false,
        shouldWarn: false,
        message: "Payment not confirmed."
      });
    }

    if (paid.twoMinuteWarningSent === true) {
      return res.json({
        ok: true,
        alreadySent: true,
        shouldWarn: false,
        message: "Two minute warning already given."
      });
    }

    applyToAllCallerRecords(phone, {
      twoMinuteWarningSent: true,
      twoMinuteWarningSentAt: new Date().toISOString()
    });

    console.log("ELEVENLABS TWO MINUTE WARNING MARKED:", { phone });

    return res.json({
      ok: true,
      shouldWarn: true,
      message: "You have about two minutes left in this session."
    });
  } catch (error) {
    console.error("ELEVENLABS TWO MINUTE WARNING ERROR:", error);

    return res.status(500).json({
      ok: false,
      shouldWarn: false,
      error: "Failed to process two minute warning.",
      details: error.message
    });
  }
});

// 10. end_session
app.post("/elevenlabs/end-session", (req, res) => {
  try {
    console.log("ELEVENLABS END SESSION REQUEST:", req.body);

    const rawPhone =
      req.body.phone_number ||
      req.body.phone ||
      req.body.customerPhone ||
      req.body.callerPhone ||
      "";

    const phone = normalizePhone(rawPhone);

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "Missing phone number."
      });
    }

    const paid = findPaidCallerRecord(phone);

    if (!paid) {
      return res.json({
        ok: false,
        paid: false,
        message: "Payment not confirmed. Nothing to end."
      });
    }

    if (paid.sessionComplete === true) {
      return res.json({
        ok: true,
        alreadyComplete: true,
        message: "Session already ended."
      });
    }

    applyToAllCallerRecords(phone, {
      sessionComplete: true,
      completedAt: new Date().toISOString(),
      completedReason: req.body.reason || "agent_ended"
    });

    console.log("ELEVENLABS SESSION ENDED:", { phone });

    return res.json({
      ok: true,
      sessionComplete: true,
      message: "Session ended."
    });
  } catch (error) {
    console.error("ELEVENLABS END SESSION ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "Failed to end session.",
      details: error.message
    });
  }
});

// 11. send_survey_sms
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
      req.body.ai_call_id
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
            p.aiCallId === callId
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

      payment.completedReason = payment.completedReason || "survey_sent";

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