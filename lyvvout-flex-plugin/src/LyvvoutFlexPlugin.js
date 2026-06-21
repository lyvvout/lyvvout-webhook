import React from 'react';
import { FlexPlugin } from '@twilio/flex-plugin';

import CustomTaskList from './components/CustomTaskList/CustomTaskList';

const PLUGIN_NAME = 'LyvvoutFlexPlugin';
const BACKEND_BASE_URL = 'https://lyvvout-webhook.onrender.com';

export default class LyvvoutFlexPlugin extends FlexPlugin {
  constructor() {
    super(PLUGIN_NAME);
  }

  async init(flex, manager) {
    const options = { sortOrder: -1 };

    if (flex.TaskInfoPanel?.Content) {
      flex.TaskInfoPanel.Content.add(
        <CustomTaskList key="LyvvoutFlexPlugin-task-info-card" />,
        options
      );
    } else {
      flex.AgentDesktopView.Panel1.Content.add(
        <CustomTaskList key="LyvvoutFlexPlugin-component" />,
        options
      );
    }

    flex.Actions.addListener('afterAcceptTask', async (payload) => {
      try {
        const task = payload?.task;

        if (!task) {
          console.warn('LYVVOUT TIMER START SKIPPED: No task found');
          return;
        }

        const attrs = task?.attributes || {};

        const isLyvvOutTask =
          attrs.lyvvout_session === true ||
          attrs.lyvvout_session === 'true' ||
          attrs.type === 'lyvvout_live_session';

        if (!isLyvvOutTask) {
          return;
        }

        const activeSessionId =
          attrs.activeSessionId ||
          attrs.sessionId ||
          '';

        const liveCallSid =
          attrs.liveCallSid ||
          attrs.callSid ||
          attrs.call_sid ||
          '';

        if (!activeSessionId || !liveCallSid) {
          console.warn('LYVVOUT TIMER START SKIPPED: Missing sessionId or liveCallSid', {
            activeSessionId,
            liveCallSid,
            attrs,
          });
          return;
        }

        const listenerName =
          manager.workerClient?.attributes?.full_name ||
          manager.workerClient?.name ||
          manager.workerClient?.attributes?.email ||
          'LyvvOut Listener';

        const listenerWorkerSid =
          manager.workerClient?.sid ||
          '';

        console.log('LYVVOUT STARTING LIVE SESSION TIMER:', {
          activeSessionId,
          liveCallSid,
          flexTaskSid: task.sid,
          listenerName,
          listenerWorkerSid,
        });

        const response = await fetch(`${BACKEND_BASE_URL}/flex/start-live-session`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            sessionId: activeSessionId,
            liveCallSid: liveCallSid,
            flexTaskSid: task.sid,
            listenerName: listenerName,
            listenerWorkerSid: listenerWorkerSid,
          }),
        });

        const data = await response.json();

        console.log('LYVVOUT LIVE SESSION TIMER RESPONSE:', data);

        if (response.ok && data && data.timer_started !== false) {
          const startedAt = new Date().toISOString();

          window.localStorage.setItem(
            `lyvvout_timer_started_${activeSessionId}`,
            startedAt
          );

          window.dispatchEvent(
            new CustomEvent('lyvvout-timer-started', {
              detail: {
                sessionId: activeSessionId,
                startedAt,
              },
            })
          );
        }
      } catch (error) {
        console.error('LYVVOUT TIMER START ERROR:', error);
      }
    });
  }
}