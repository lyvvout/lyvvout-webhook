require('dotenv').config();
const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

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

// =====================================================================
// PERSISTENT STORAGE (Supabase)
// One row per caller phone (E.164). This replaces the old in-memory Maps,
// so a Render restart or redeploy no longer wipes a live call's state.
// =====================================================================

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "WARNING: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are not set. " +
    "Caller state cannot be stored. Set these in your environment."
  );
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SESSIONS_TABLE = "lyvvout_sessions";

// camelCase (code) -> snake_case (database column).
// Aliases customerName/displayName collapse onto caller_name on purpose.
const FIELD_MAP = {
  phone: "phone",
  callId: "call_id",
  source: "source",
  paid: "paid",
  language: "language",
  callerName: "caller_name",
  customerName: "caller_name",
  displayName: "caller_name",
  sessionType: "session_type",
  sessionTypeLabel: "session_type_label",
  voiceGender: "voice_gender",
  sessionSeconds: "session_seconds",
  totalSessionSeconds: "total_session_seconds",
  timerStarted: "timer_started",
  sessionStartedAt: "session_started_at",
  twoMinuteWarningSent: "two_minute_warning_sent",
  twoMinuteWarningSentAt: "two_minute_warning_sent_at",
  sessionComplete: "session_complete",
  completedAt: "completed_at",
  completedReason: "completed_reason",
  surveySmsSent: "survey_sms_sent",
  surveySmsSentAt: "survey_sms_sent_at",
  surveySmsSid: "survey_sms_sid",
  stripeSessionId: "stripe_session_id",
  amountTotal: "amount_total",
  currency: "currency",
  paymentStatus: "payment_status",
  paidAt: "paid_at",
  paidSessionAgentId: "paid_session_agent_id",
  paidSessionRequestedAt: "paid_session_requested_at",
  customerEmail: "customer_email"
};

// camelCase updates -> snake_case DB patch. Null values are written through
// (intake uses them to reset a returning caller's row to a clean slate).
function toRow(updates) {
  const row = {};
  for (const [key, value] of Object.entries(updates)) {
    const col = FIELD_MAP[key];
    if (col) row[col] = value;
  }
  return row;
}

// DB row -> the exact camelCase record shape the routes already read.
function toRecord(row) {
  if (!row) return null;

  const sessionSeconds = row.session_seconds == null ? 900 : row.session_seconds;
  const sessionLength = String(Math.round(sessionSeconds / 60));

  return {
    phone: row.phone,
    customerPhone: row.phone,
    callerPhone: row.phone,
    callId: row.call_id,
    source: row.source,
    paid: row.paid === true,
    language: row.language,
    callerName: row.caller_name,
    customerName: row.caller_name,
    displayName: row.caller_name,
    sessionType: row.session_type,
    sessionTypeLabel: row.session_type_label,
    voiceGender: row.voice_gender,
    sessionSeconds,
    sessionLength,
    plan: { sessionLength, seconds: sessionSeconds },
    totalSessionSeconds: row.total_session_seconds,
    timerStarted: row.timer_started === true,
    sessionStartedAt: row.session_started_at,
    twoMinuteWarningSent: row.two_minute_warning_sent === true,
    twoMinuteWarningSentAt: row.two_minute_warning_sent_at,
    sessionComplete: row.session_complete === true,
    completedAt: row.completed_at,
    completedReason: row.completed_reason,
    surveySmsSent: row.survey_sms_sent === true,
    surveySmsSentAt: row.survey_sms_sent_at,
    surveySmsSid: row.survey_sms_sid,
    stripeSessionId: row.stripe_session_id,
    amountTotal: row.amount_total,
    currency: row.currency,
    paymentStatus: row.payment_status,
    paidAt: row.paid_at,
    paidSessionAgentId: row.paid_session_agent_id,
    customerEmail: row.customer_email,
    updatedAt: row.updated_at,
    createdAt: row.created_at
  };
}

function normalizePhone(value) {
  if (!value) return "";
  const digits = String(value).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return String(value).trim();
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

// ---------------------------------------------------------------------
// The five storage choke points, now backed by Supabase. Every route uses
// only these, so the routes themselves stay identical apart from async/await.
// ---------------------------------------------------------------------

// All caller records matching this phone. One row per phone, so this is 0 or
// 1 record, returned as an array so callers using pickFirstDefined still work.
async function getAllCallerRecords(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return [];

  const { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .select("*")
    .eq("phone", normalized)
    .limit(1);

  if (error) {
    console.error("SUPABASE getAllCallerRecords ERROR:", error.message);
    throw error;
  }

  return (data || []).map(toRecord);
}

// First non-empty value of a field across a set of already-fetched records.
function pickFirstDefined(records, field) {
  for (const r of records) {
    if (r && r[field] !== undefined && r[field] !== null && r[field] !== "") {
      return r[field];
    }
  }
  return undefined;
}

// The confirmed-paid record for a caller, or null.
async function findPaidCallerRecord(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .select("*")
    .eq("phone", normalized)
    .eq("paid", true)
    .limit(1);

  if (error) {
    console.error("SUPABASE findPaidCallerRecord ERROR:", error.message);
    throw error;
  }

  return data && data[0] ? toRecord(data[0]) : null;
}

// Update the existing row for this phone. Returns the updated record(s) as an
// array (0 or 1). An empty array means no row existed — callers rely on that
// to return "run save_intake_info first" / "payment not confirmed".
async function applyToAllCallerRecords(phone, updates) {
  const normalized = normalizePhone(phone);
  if (!normalized) return [];

  const row = toRow(updates);
  row.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .update(row)
    .eq("phone", normalized)
    .select();

  if (error) {
    console.error("SUPABASE applyToAllCallerRecords ERROR:", error.message);
    throw error;
  }

  return (data || []).map(toRecord);
}

// Create-or-update the row for this phone. Used by intake and the Stripe
// webhook. On conflict, only the supplied columns are written, so fields not
// passed (e.g. caller_name, language at payment time) are preserved.
async function upsertCallerRecord(phone, updates) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error("upsertCallerRecord requires a phone.");

  const row = toRow(updates);
  row.phone = normalized;
  row.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .upsert(row, { onConflict: "phone" })
    .select();

  if (error) {
    console.error("SUPABASE upsertCallerRecord ERROR:", error.message);
    throw error;
  }

  return data && data[0] ? toRecord(data[0]) : null;
}

// Fallback for survey SMS: most recent paid, not-yet-complete caller.
async function findMostRecentPaidRecord() {
  const { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .select("*")
    .eq("paid", true)
    .eq("session_complete", false)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("SUPABASE findMostRecentPaidRecord ERROR:", error.message);
    throw error;
  }

  return data && data[0] ? toRecord(data[0]) : null;
}

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

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        // The caller is told to pay with the same phone they gave at intake,
        // so the intake row already exists keyed by this phone. We flip it
        // to paid and attach the payment details.
        const phone = normalizePhone(session.customer_details?.phone || "");

        const sessionSeconds =
          Number(session.metadata?.seconds) ||
          (session.amount_total === 1499 ? 900 : 900);

        const updates = {
          paid: true,
          stripeSessionId: session.id,
          customerEmail: session.customer_details?.email || null,
          amountTotal: session.amount_total,
          currency: session.currency,
          paymentStatus: session.payment_status,
          sessionSeconds,
          totalSessionSeconds: sessionSeconds,
          paidAt: new Date().toISOString(),

          // Fresh timer/session state at payment time. The paid agent starts
          // the clock later via start_session_timer.
          timerStarted: false,
          sessionStartedAt: null,
          twoMinuteWarningSent: false,
          surveySmsSent: false,
          sessionComplete: false
        };

        if (phone) {
          const record = await upsertCallerRecord(phone, updates);
          console.log("Payment confirmed and linked:", {
            phone,
            callerName: record?.callerName,
            language: record?.language,
            amount: session.amount_total
          });
        } else {
          // Payment succeeded but Stripe returned no phone to match on. The
          // payment link must collect the customer's phone number for this
          // flow to link the payment to the caller.
          console.error(
            "PAYMENT WITHOUT MATCHABLE PHONE — enable phone collection on the " +
            "Stripe payment link. Stripe session:",
            session.id
          );
        }
      }
    } catch (err) {
      console.error("STRIPE WEBHOOK HANDLER ERROR:", err.message);
      // Still 200 so Stripe doesn't hammer retries on a logic error; the line
      // above logs enough to investigate.
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
    storage: "supabase",
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

// =====================================================================
// PHASE 1 — INTAKE + PAYMENT
// =====================================================================

// 1. save_intake_info
app.post("/elevenlabs/save-intake-info", async (req, res) => {
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

    // Full reset: starting intake means a new session for this phone, so we
    // clear any leftover state from a previous session by the same caller.
    await upsertCallerRecord(phone, {
      callId: intakeId,
      source: "elevenlabs_intake",
      paid: false,
      language,
      callerName,
      sessionType: null,
      sessionTypeLabel: null,
      voiceGender: null,
      sessionSeconds: 900,
      totalSessionSeconds: 900,
      timerStarted: false,
      sessionStartedAt: null,
      twoMinuteWarningSent: false,
      twoMinuteWarningSentAt: null,
      sessionComplete: false,
      completedAt: null,
      completedReason: null,
      surveySmsSent: false,
      surveySmsSentAt: null,
      surveySmsSid: null,
      stripeSessionId: null,
      amountTotal: null,
      currency: null,
      paymentStatus: null,
      paidAt: null,
      paidSessionAgentId: null,
      paidSessionRequestedAt: null,
      customerEmail: null
    });

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
app.post("/elevenlabs/check-payment", async (req, res) => {
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

    const matches = await getAllCallerRecords(phone);

    const payment = matches.find((p) => p.paid === true) || matches[0];
    const language = pickFirstDefined(matches, "language") || "english";

    console.log("ELEVENLABS CHECK PAYMENT RESULT:", {
      phone,
      found: !!payment,
      paid: payment?.paid,
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
app.post("/elevenlabs/save-session-type", async (req, res) => {
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

    const records = await applyToAllCallerRecords(phone, {
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
app.post("/elevenlabs/save-voice-preference", async (req, res) => {
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

    const records = await applyToAllCallerRecords(phone, { voiceGender });

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
app.post("/elevenlabs/start-paid-session", async (req, res) => {
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

    const records = await getAllCallerRecords(phone);

    if (records.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "No caller record found for this phone."
      });
    }

    const paid = await findPaidCallerRecord(phone);

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

    await applyToAllCallerRecords(phone, {
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
app.post("/elevenlabs/start-session-timer", async (req, res) => {
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

    const paid = await findPaidCallerRecord(phone);

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
    const records = await getAllCallerRecords(phone);
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

    await applyToAllCallerRecords(phone, {
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
app.post("/elevenlabs/check-session-time", async (req, res) => {
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

    const paid = await findPaidCallerRecord(phone);

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

    // Once the session is already marked complete, the closing and the two
    // minute warning have already happened. Force both flags to false so the
    // agent can never be told to close or warn a second time, no matter how
    // many times it polls. This makes a doubled ending impossible.
    const alreadyComplete = paid.sessionComplete === true;

    const expired = !alreadyComplete && secondsRemaining <= 0;
    const twoMinuteWarningDue =
      !alreadyComplete &&
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
      sessionComplete: alreadyComplete,
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
app.post("/elevenlabs/send-two-minute-warning", async (req, res) => {
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

    const paid = await findPaidCallerRecord(phone);

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

    await applyToAllCallerRecords(phone, {
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
app.post("/elevenlabs/end-session", async (req, res) => {
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

    const paid = await findPaidCallerRecord(phone);

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

    await applyToAllCallerRecords(phone, {
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

    let payment = null;
    if (phone) {
      const records = await getAllCallerRecords(phone);
      payment = records[0] || null;
    }

    if (!payment) {
      payment = await findMostRecentPaidRecord();
    }

    const toPhone = normalizePhone(payment?.phone || phone);

    if (!toPhone || isTemplateValue(toPhone)) {
      console.log("SURVEY SMS SKIPPED - NO REAL PHONE:", {
        rawPhone,
        phone,
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
        toPhone
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

    await applyToAllCallerRecords(toPhone, {
      surveySmsSent: true,
      surveySmsSentAt: new Date().toISOString(),
      surveySmsSid: msg.sid,
      completedReason: payment?.completedReason || "survey_sent"
    });

    console.log("SURVEY SMS SENT:", {
      to: toPhone,
      sid: msg.sid,
      surveySmsSent: true
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