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

function formatPhoneForSpeech(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  const last10 = digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits;

  if (last10.length !== 10) return phone;

  return `${last10.slice(0, 3)}-${last10.slice(3, 6)}-${last10.slice(6)}`;
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

function findPaymentForAISession(req) {
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
    req.body.ai_call_id ||
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
          p.aiCallId === callId 
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
    aiSessionStatus: "/elevenlabs/session-status",
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

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
            p.aiCallId === callId ||
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

app.post("/twilio/voice", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const gather = response.gather({
    numDigits: 1,
    action: "/twilio/collect-language",
    method: "POST",
    timeout: 10
  });

  gather.say(
    { voice:  "Polly.Kendra", language: "en-US" },
    "Welcome to LyvvOut,  a confidential, judgment-free hotline. I'm your intake guide. This call is completely private. Nothing is recorded. I am going to collect a few quick details to get your session started. Press 1 for English. Press 2 for Spanish."
  );

  response.redirect("/twilio/voice");

  res.type("text/xml");
  res.send(response.toString());
});

app.post("/twilio/collect-language", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const digit = req.body.Digits;
  const callSid = req.body.CallSid;
  const from = normalizePhone(req.body.From);

  const language = digit === "2" ? "spanish" : "english";

  const paymentRecord = {
    callId: callSid,
    twilioCallSid: callSid,
    callerPhone: from,
    language,
    paid: false,
    sessionComplete: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  payments.set(callSid, paymentRecord);
  if (from) payments.set(from, paymentRecord);

  const gather = response.gather({
    input: "speech",
    action: "/twilio/collect-name",
    method: "POST",
    timeout: 6,
    speechTimeout: "auto"
  });

  if (language === "spanish") {
    gather.say(
      { voice: "Polly.Mia", language: "es-MX" },
      "Por favor, diga su nombre después del tono."
    );
  } else {
    gather.say(
      { voice:  "Polly.Kendra", language: "en-US" },
      "Please say your name after the tone."
    );
  }

  response.redirect("/twilio/collect-language");

  res.type("text/xml");
  res.send(response.toString());
});

app.post("/twilio/collect-name", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const callSid = req.body.CallSid;
  const callerName = req.body.SpeechResult || "Caller";

  const payment = payments.get(callSid) || {};
  payment.callerName = callerName;
  payment.customerName = callerName;
  payment.updatedAt = new Date().toISOString();

  payments.set(callSid, payment);

  const gather = response.gather({
    input: "dtmf",
    action: "/twilio/collect-phone",
    method: "POST",
    timeout: 15,
    finishOnKey: "#"
  });

  gather.say(
    { voice: "Polly.Mia", language: payment.language === "spanish" ? "es-MX" : "en-US" },
    payment.language === "spanish"
      ? "Ahora ingrese su número de teléfono de diez dígitos, luego presione la tecla numeral."
      : "Now enter your ten digit phone number, then press the pound key."
  );

  response.redirect("/twilio/collect-name");

  res.type("text/xml");
  res.send(response.toString());
});

app.post("/twilio/collect-phone", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const callSid = req.body.CallSid;
  const digits = String(req.body.Digits || "").replace(/\D/g, "");

  const payment = payments.get(callSid) || {};
  const isSpanish = payment.language === "spanish";

  if (digits.length < 10) {
    const gather = response.gather({
      input: "dtmf",
      action: "/twilio/collect-phone",
      method: "POST",
      timeout: 20,
      finishOnKey: "#"
    });

    gather.say(
      {
        voice: isSpanish ? "Polly.Mia" : "Polly.Kendra",
        language: isSpanish ? "es-MX" : "en-US"
      },
      isSpanish
        ? "No recibí un número de teléfono completo. Por favor ingrese su número de diez dígitos y luego presione la tecla numeral."
        : "I did not receive a full phone number. Please enter your ten digit phone number and then press the pound key."
    );

    response.redirect("/twilio/collect-phone");

    res.type("text/xml");
    return res.send(response.toString());
  }

  const phone = normalizePhone(digits);

  payment.customerPhone = phone;
  payment.phone = phone;
  payment.updatedAt = new Date().toISOString();

  payments.set(callSid, payment);
  payments.set(phone, payment);

  pendingCallerNames.set(phone, payment.callerName || "Caller");

  const spokenPhone = formatPhoneForSpeech(phone);

  const gather = response.gather({
    numDigits: 1,
    action: "/twilio/confirm-phone",
    method: "POST",
    timeout: 10
  });

  gather.say(
    {
      voice: isSpanish ? "Polly.Mia" : "Polly.Kendra",
      language: isSpanish ? "es-MX" : "en-US"
    },
    isSpanish
      ? `Tengo su número como ${spokenPhone}. Si es correcto, presione 1. Para ingresarlo nuevamente, presione 2.`
      : `I have your phone number as ${spokenPhone}. If that is correct, press 1. To re-enter it, press 2.`
  );

  res.type("text/xml");
  res.send(response.toString());
});

app.post("/twilio/confirm-phone", async (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const callSid = req.body.CallSid;
  const digit = req.body.Digits;

  const payment = payments.get(callSid) || {};
  const isSpanish = payment.language === "spanish";

  if (digit === "2") {
    const gather = response.gather({
      input: "dtmf",
      action: "/twilio/collect-phone",
      method: "POST",
      timeout: 20,
      finishOnKey: "#"
    });

    gather.say(
      {
        voice: isSpanish ? "Polly.Mia" : "Polly.Kendra",
        language: isSpanish ? "es-MX" : "en-US"
      },
      isSpanish
        ? "No hay problema. Ingrese nuevamente su número de teléfono de diez dígitos, y luego presione la tecla de número."
        : "No problem. Please re-enter your ten digit phone number, then press the pound key."
    );

    response.redirect("/twilio/collect-phone");

    res.type("text/xml");
    return res.send(response.toString());
  }

  try {
    await twilioClient.messages.create({
      to: payment.customerPhone,
      from: process.env.TWILIO_PHONE_NUMBER,
      body:
        isSpanish
          ? "LyvvOut: Aquí está su enlace seguro de pago para su sesión de 15 minutos de LyvvOut: https://lyvvout.com/#payment. Responda STOP para cancelar mensajes. Responda HELP para ayuda. Pueden aplicarse tarifas de mensajes y datos."
          : "LyvvOut: Here is your secure payment link for your 15-minute LyvvOut session: https://lyvvout.com/#payment. Reply STOP to opt out. Reply HELP for help. Msg & data rates may apply."
    });

    response.say(
      {
        voice: isSpanish ? "Polly.Mia" : "Polly.Kendra",
        language: isSpanish ? "es-MX" : "en-US"
      },
      isSpanish
        ? "Le acabamos de enviar un enlace seguro de pago por mensaje de texto. Complete el pago usando el mismo número de teléfono que proporcionó."
        : "We just texted your secure payment link. Please complete payment using the same phone number you entered."
    );

    const gather = response.gather({
      numDigits: 1,
      action: "/twilio/check-payment",
      method: "POST",
      timeout: 60
    });

    gather.say(
      {
        voice: isSpanish ? "Polly.Mia" : "Polly.Kendra",
        language: isSpanish ? "es-MX" : "en-US"
      },
      isSpanish
        ? "Cuando complete el pago, presione 1 para continuar."
        : "When you complete payment, press 1 to continue."
    );
  } catch (error) {
    console.error("TWILIO PAYMENT SMS ERROR:", error.message);

    response.say(
      { voice: isSpanish ? "Polly.Mia" : "Polly.Kendra", language: isSpanish ? "es-MX" : "en-US" },
      isSpanish
        ? "No pudimos enviar el mensaje de pago. Por favor intente nuevamente más tarde."
        : "We could not send the payment text. Please try again later."
    );

    response.hangup();
  }

  res.type("text/xml");
  res.send(response.toString());
});

app.post("/twilio/check-payment", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  response.redirect("/twilio/wait-for-payment");

  res.type("text/xml");
  res.send(response.toString());
});

app.post("/twilio/wait-for-payment", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const callSid = req.body.CallSid;
  const from = normalizePhone(req.body.From);

  const allPayments = [...new Set([...payments.values()])];

  const payment =
    allPayments.find((p) =>
      p &&
      p.paid === true &&
      (
        p.callId === callSid ||
        p.twilioCallSid === callSid ||
        normalizePhone(p.customerPhone) === from ||
        normalizePhone(p.phone) === from ||
        normalizePhone(p.callerPhone) === from
      )
    ) ||
    payments.get(from) ||
    payments.get(callSid);

  console.log("WAIT FOR PAYMENT CHECK:", {
    callSid,
    from,
    found: !!payment,
    paid: payment?.paid,
    customerPhone: payment?.customerPhone,
    phone: payment?.phone,
    paymentCallId: payment?.callId
  });

  if (payment?.paid === true) {
    if (callSid) {
      payment.twilioCallSid = callSid;
      payments.set(callSid, payment);
    }

    if (from) payments.set(from, payment);

    response.say(
      {
        voice: payment.language === "spanish" ? "Polly.Mia" : "Polly.Kendra",
        language: payment.language === "spanish" ? "es-MX" : "en-US"
      },
      payment.language === "spanish"
        ? "Pago confirmado. Continuemos."
        : "Payment confirmed. Let's continue."
    );

    response.redirect("/twilio/collect-session-type");
  } else {
    response.say(
      {
        voice: payment?.language === "spanish" ? "Polly.Mia" : "Polly.Kendra",
        language: payment?.language === "spanish" ? "es-MX" : "en-US"
      },
      payment?.language === "spanish"
        ? "Aún estamos esperando la confirmación del pago. Permanezca en la línea."
        : "We are still waiting for payment confirmation. Please stay on the line."
    );

    response.pause({ length: 10 });
    response.redirect("/twilio/wait-for-payment");
  }

  res.type("text/xml");
  res.send(response.toString());
});

app.post("/twilio/collect-session-type", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const callSid = req.body.CallSid;
  const from = normalizePhone(req.body.From);

  const payment =
    payments.get(callSid) ||
    payments.get(from) ||
    [...payments.values()].find((p) => {
      return (
        p &&
        p.paid === true &&
        (
          p.callId === callSid ||
          p.twilioCallSid === callSid ||
          normalizePhone(p.customerPhone) === from ||
          normalizePhone(p.phone) === from
        )
      );
    });

  const language = payment?.language || "english";

  const gather = response.gather({
    numDigits: 1,
    action: "/twilio/collect-voice-gender",
    method: "POST",
    timeout: 10
  });

  if (language === "spanish") {
    gather.say(
  { voice: "Polly.Mia", language: "es-MX" },
  "Ahora elija el tono de su sesión. Presione 1 para Solo Escuchar: silencio, presencia, sin consejos. Presione 2 para Reaccionar Conmigo: validación y reacciones reales. Presione 3 para Sesión de Ánimo: apoyo, motivación y energía positiva. Presione 4 para Hablar Claro: honesto, firme y directo. Presione 5 para Sin Filtro: crudo, expresivo y sin juicio."
);
  } else {
    gather.say(
  { voice:  "Polly.Kendra", language: "en-US" },
  "Now let’s set the tone for your session. Press 1 for Just Listen: quiet, present, no advice. Press 2 for React With Me: validation and real reactions. Press 3 for Hype Session: uplifting and fully in your corner. Press 4 for Keep It Real: honest, grounded, and direct. Press 5 for No Filter: raw, expressive, zero judgment."
);
  }

  response.redirect("/twilio/collect-session-type");

  res.type("text/xml");
  res.send(response.toString());
});

app.post("/twilio/collect-voice-gender", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const callSid = req.body.CallSid;
  const from = normalizePhone(req.body.From);
  const digit = req.body.Digits;

  const sessionTypes = {
    "1": "just_listen",
    "2": "react_with_me",
    "3": "hype_session",
    "4": "keep_it_real",
    "5": "no_filter"
  };

  const sessionType = sessionTypes[digit] || "hype_session";

  const payment =
    payments.get(callSid) ||
    payments.get(from) ||
    findMostRecentActivePaidPayment();

  if (payment) {
    payment.sessionType = sessionType;
    payment.updatedAt = new Date().toISOString();
    payments.set(callSid, payment);
    if (from) payments.set(from, payment);
  }

  const language = payment?.language || "english";

  const gather = response.gather({
    numDigits: 1,
    action: "/twilio/start-elevenlabs",
    method: "POST",
    timeout: 10
  });

  if (language === "spanish") {
    gather.say(
      { voice: "Polly.Mia", language: "es-MX" },
      "Elija su preferencia de voz. Presione 1 para voz femenina. Presione 2 para voz masculina."
    );
  } else {
    gather.say(
      { voice:  "Polly.Kendra", language: "en-US" },
      "Choose your voice preference. Press 1 for a female voice. Press 2 for a male voice."
    );
  }

  response.redirect("/twilio/collect-voice-gender");

  res.type("text/xml");
  res.send(response.toString());
});

app.post("/twilio/start-elevenlabs", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const callSid = req.body.CallSid;
  const from = normalizePhone(req.body.From);
  const digit = req.body.Digits;

  const voiceGender = digit === "2" ? "male" : "female";

  const payment =
    payments.get(callSid) ||
    payments.get(from) ||
    findMostRecentActivePaidPayment();

  if (!payment) {
    console.log("START ELEVENLABS FAILED - NO PAYMENT FOUND", {
      callSid,
      from,
      digit
    });

    response.say(
      { voice: "Polly.Kendra", language: "en-US" },
      "We could not find your paid session. Please call back or contact LyvvOut support."
    );
    response.hangup();

    res.type("text/xml");
    return res.send(response.toString());
  }

  payment.voiceGender = voiceGender;
  payment.updatedAt = new Date().toISOString();

  const language = payment.language || "english";

  let agentId;

  if (language === "spanish" && voiceGender === "female") {
    agentId = process.env.ELEVENLABS_AGENT_ES_FEMALE;
  } else if (language === "spanish" && voiceGender === "male") {
    agentId = process.env.ELEVENLABS_AGENT_ES_MALE;
  } else if (language === "english" && voiceGender === "female") {
    agentId = process.env.ELEVENLABS_AGENT_EN_FEMALE;
  } else {
    agentId = process.env.ELEVENLABS_AGENT_EN_MALE;
  }

  payment.elevenLabsAgentId = agentId;
  payments.set(callSid, payment);
  if (from) payments.set(from, payment);
  if (payment.customerPhone) payments.set(payment.customerPhone, payment);

  console.log("START ELEVENLABS SELECTED:", {
    callSid,
    from,
    language,
    voiceGender,
    sessionType: payment.sessionType,
    agentId,
    callerName: payment.callerName,
    customerPhone: payment.customerPhone
  });

  response.say(
    {
      voice: language === "spanish" ? "Polly.Mia" : "Polly.Kendra",
      language: language === "spanish" ? "es-MX" : "en-US"
    },
    language === "spanish"
      ? "Perfecto. Vamos a comenzar su sesión ahora."
      : "Perfect. We are starting your session now."
  );

  response.pause({ length: 1 });

  response.say(
    {
      voice: language === "spanish" ? "Polly.Mia" : "Polly.Kendra",
      language: language === "spanish" ? "es-MX" : "en-US"
    },
    language === "spanish"
      ? "La conexión con el agente de voz de ElevenLabs será el siguiente paso."
      : "The ElevenLabs voice connection will be the next step."
  );

  response.hangup();

  res.type("text/xml");
  res.send(response.toString());
});

app.listen(PORT, () => {
  console.log(`LyvvOut webhook server running on port ${PORT}`);
});