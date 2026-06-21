import React, { useEffect, useState } from 'react';
import { withTaskContext, Manager } from '@twilio/flex-ui';

const BACKEND_BASE_URL = 'https://lyvvout-webhook.onrender.com';

const formatSessionType = (value) => {
  if (!value) return 'Not provided';

  const labels = {
    just_listen: 'Just Listen',
    react_with_me: 'React With Me',
    hype_session: 'Hype Session',
    keep_it_real: 'Keep It Real',
    no_filter: 'No Filter',
  };

  return labels[value] || String(value).replace(/_/g, ' ');
};

const formatTime = (seconds) => {
  const safeSeconds = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;

  return `${minutes}:${String(secs).padStart(2, '0')}`;
};

const CustomTaskList = ({ task }) => {
  const attrs = task?.attributes || {};

  const callerName =
    attrs.callerName ||
    attrs.customerName ||
    attrs.name ||
    attrs.displayName ||
    attrs.caller_name ||
    attrs.customer_name ||
    'Unknown';

  const sessionType =
    attrs.sessionType ||
    attrs.selectedPersona ||
    attrs.session_type ||
    attrs.selected_persona ||
    attrs.sessionLabel ||
    attrs.session_label ||
    'Not provided';

  const sessionSeconds = Number(
    attrs.session_seconds ||
      attrs.totalSessionSeconds ||
      attrs.sessionSeconds ||
      900
  );

  const callerPhone =
    attrs.callerPhone ||
    attrs.customerPhone ||
    attrs.caller_phone ||
    attrs.caller_number ||
    attrs.from ||
    '';

  const activeSessionId =
    attrs.activeSessionId ||
    attrs.sessionId ||
    '';

 const isLyvvOutTask =
  attrs.lyvvout_session === true ||
  attrs.lyvvout_session === 'true' ||
  attrs.type === 'lyvvout_live_session';

const [remainingSeconds, setRemainingSeconds] = useState(sessionSeconds);

const [submitted, setSubmitted] = useState(false);
const [submitError, setSubmitError] = useState('');

const [form, setForm] = useState({
  self_harm_mentioned: false,
  threats_made: false,
  terms_violated: false,
  abusive_language: false,
  emergency_services_needed: false,
  call_had_no_issues: false,
  notes: ''
});

const [timerStartedAt, setTimerStartedAt] = useState(() => {
  if (!activeSessionId) return '';
  return window.localStorage.getItem(`lyvvout_timer_started_${activeSessionId}`) || '';
});

useEffect(() => {
  if (!activeSessionId) return;

  const existingStart =
    window.localStorage.getItem(`lyvvout_timer_started_${activeSessionId}`) || '';

  setTimerStartedAt(existingStart);
}, [activeSessionId]);

useEffect(() => {
  const handleTimerStarted = (event) => {
    if (!event?.detail?.sessionId) return;

    if (event.detail.sessionId === activeSessionId) {
      setTimerStartedAt(event.detail.startedAt || new Date().toISOString());
    }
  };

  window.addEventListener('lyvvout-timer-started', handleTimerStarted);

  return () => {
    window.removeEventListener('lyvvout-timer-started', handleTimerStarted);
  };
}, [activeSessionId]);

useEffect(() => {
  if (!isLyvvOutTask || !task || !timerStartedAt) {
    setRemainingSeconds(sessionSeconds);
    return;
  }

  const tick = () => {
    const started = new Date(timerStartedAt).getTime();
    const elapsed = Math.floor((Date.now() - started) / 1000);
    const remaining = Math.max(0, sessionSeconds - elapsed);

    setRemainingSeconds(remaining);
  };

  tick();

  const interval = setInterval(tick, 1000);

  return () => clearInterval(interval);
}, [isLyvvOutTask, task, timerStartedAt, sessionSeconds]);

const taskStatus = String(task?.status || task?.taskStatus || '').toLowerCase();

const isWrapUp =
  taskStatus === 'wrapping' ||
  taskStatus === 'wrapup' ||
  taskStatus === 'completed';

if (!task || !isLyvvOutTask) {
  return null;
}

const updateCheckbox = (field) => {
  setForm((prev) => ({
    ...prev,
    [field]: !prev[field],
  }));
};

  const submitCallLog = async () => {
    try {
      setSubmitError('');

      const manager = Manager.getInstance();

      const listenerName =
        manager.workerClient?.attributes?.full_name ||
        manager.workerClient?.name ||
        manager.workerClient?.attributes?.email ||
        'LyvvOut Listener';

      const response = await fetch(`${BACKEND_BASE_URL}/flex/call-log`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      body: JSON.stringify({
  listener_name: listenerName,
  caller_phone: callerPhone,
  session_type: sessionType,
  self_harm_mentioned: form.self_harm_mentioned,
  threats_made: form.threats_made,
  terms_violated: form.terms_violated,
  abusive_language: form.abusive_language,
  emergency_services_needed: form.emergency_services_needed,
  call_had_no_issues: form.call_had_no_issues,
  notes: form.notes
})
      });

      const data = await response.json();

      if (!response.ok || data.ok === false) {
        throw new Error(data.message || data.error || 'Failed to save call log');
      }

      setSubmitted(true);
    } catch (error) {
      setSubmitError(error.message || 'Failed to submit call log');
    }
  };

  return (
    <div
      style={{
        background: '#111224',
        color: '#ffffff',
        borderRadius: '8px',
        padding: '18px',
        margin: '16px 0',
        fontFamily: 'Inter, Arial, sans-serif',
        boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
      }}
    >
      <div
        style={{
          fontSize: '14px',
          color: '#b8bacf',
          marginBottom: '10px',
          letterSpacing: '0.2px',
        }}
      >
        LyvvOut Session
      </div>

      <div style={{ fontSize: '16px', marginBottom: '8px' }}>
        <strong>Caller:</strong> {callerName}
      </div>

      <div style={{ fontSize: '16px', marginBottom: '8px' }}>
        <strong>Session Type:</strong> {formatSessionType(sessionType)}
      </div>

      <div style={{ fontSize: '16px', marginBottom: '8px' }}>
        <strong>Timer:</strong> {formatTime(remainingSeconds)}
      </div>

{remainingSeconds <= 120 && remainingSeconds > 0 && (
  <div
    style={{
      background: '#fff3cd',
      color: '#3b2f00',
      borderRadius: '6px',
      padding: '10px',
      marginBottom: '10px',
      fontWeight: 700,
      border: '1px solid #ffe08a',
    }}
  >
    2 minutes remaining. Begin wrapping up the session and let the caller know they will receive a short survey by text.
  </div>
)}

      {callerPhone && (
        <div style={{ fontSize: '14px', color: '#d6d7e6', marginBottom: '8px' }}>
          <strong>Phone:</strong> {callerPhone}
        </div>
      )}

      {activeSessionId && (
        <div style={{ fontSize: '12px', color: '#8f91a8', marginTop: '12px' }}>
          Session ID: {activeSessionId}
        </div>
      )}

      {isWrapUp && (
        <div
          style={{
            marginTop: '18px',
            paddingTop: '16px',
            borderTop: '1px solid rgba(255,255,255,0.18)',
          }}
        >
          <div style={{ fontSize: '16px', fontWeight: 700, marginBottom: '10px' }}>
            After-Call Wrap-Up
          </div>

          <label style={{ display: 'block', marginBottom: '8px' }}>
            <input
              type="checkbox"
              checked={form.self_harm_mentioned}
              onChange={() => updateCheckbox('self_harm_mentioned')}
            />{' '}
            Did the caller express thoughts of self-harm?
          </label>

          <label style={{ display: 'block', marginBottom: '8px' }}>
            <input
              type="checkbox"
              checked={form.threats_made}
              onChange={() => updateCheckbox('threats_made')}
            />{' '}
            Did the caller make any threats?
          </label>

          <label style={{ display: 'block', marginBottom: '8px' }}>
            <input
              type="checkbox"
              checked={form.terms_violated}
              onChange={() => updateCheckbox('terms_violated')}
            />{' '}
            Did the caller violate the terms and conditions?
          </label>

          <label style={{ display: 'block', marginBottom: '8px' }}>
            <input
              type="checkbox"
              checked={form.abusive_language}
              onChange={() => updateCheckbox('abusive_language')}
            />{' '}
            Did the caller use abusive or threatening language?
          </label>

          <label style={{ display: 'block', marginBottom: '12px' }}>
            <input
              type="checkbox"
              checked={form.emergency_services_needed}
              onChange={() => updateCheckbox('emergency_services_needed')}
            />{' '}
            Was law enforcement or emergency services needed?
          </label>

<label style={{ display: 'block', marginBottom: '12px' }}>
  <input
    type="checkbox"
    checked={form.call_had_no_issues}
    onChange={() => updateCheckbox('call_had_no_issues')}
  />{' '}
  Call had no issues
</label>

          <textarea
            value={form.notes}
            onChange={(e) =>
              setForm((prev) => ({
                ...prev,
                notes: e.target.value,
              }))
            }
            placeholder="Additional notes..."
            style={{
              width: '100%',
              minHeight: '90px',
              borderRadius: '6px',
              border: '1px solid #d6d7e6',
              padding: '10px',
              fontFamily: 'Inter, Arial, sans-serif',
              marginBottom: '12px',
            }}
          />

          <button
            type="button"
            onClick={submitCallLog}
            disabled={submitted}
            style={{
              background: submitted ? '#4f556f' : '#2f80ed',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              padding: '10px 14px',
              fontWeight: 700,
              cursor: submitted ? 'default' : 'pointer',
            }}
          >
            {submitted ? 'Call Log Saved' : 'Submit Call Log'}
          </button>

          {submitError && (
            <div style={{ color: '#ffb4b4', marginTop: '10px' }}>
              {submitError}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default withTaskContext(CustomTaskList);