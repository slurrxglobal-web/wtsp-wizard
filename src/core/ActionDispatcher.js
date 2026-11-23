import { AntiBanGuard } from './AntiBanGuard.js';

export class ActionDispatcher {
  /**
   * @param {import('./SessionManager.js').SessionManager} sessionManager
   * @param {EventEmitter} [eventEmitter]
   */
  constructor(sessionManager, eventEmitter = null) {
    this.sessionManager = sessionManager;
    this.emitter = eventEmitter || sessionManager;
  }

  /**
   * Broadcasts/mirrors a message to a target recipient from all (or specified) sessions.
   * @param {Object} params
   * @param {string} params.target - Recipient phone number or JID
   * @param {string} params.message - Raw text or Spintax template
   * @param {string[]} [params.sessionIds] - Optional list of specific sessions (defaults to all connected)
   * @param {number} [params.minDelay=1000] - Min delay in ms between account dispatches
   * @param {number} [params.maxDelay=3000] - Max delay in ms between account dispatches
   * @param {boolean} [params.simulateTyping=true] - Simulate human typing indicator before dispatch
   */
  async mirrorSendMessage({
    target,
    message,
    sessionIds = null,
    minDelay = 1000,
    maxDelay = 3000,
    simulateTyping = true
  }) {
    const targetJid = AntiBanGuard.sanitizeTarget(target);
    if (!targetJid) {
      throw new Error('Valid target recipient number or JID is required');
    }

    const activeSessions = sessionIds && sessionIds.length > 0
      ? sessionIds
      : this.sessionManager.getConnectedSessionIds();

    if (activeSessions.length === 0) {
      throw new Error('No connected sessions available to execute action');
    }

    const actionId = `act_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const results = [];

    this.emitter.emit('action_started', {
      actionId,
      type: 'send_message',
      target: targetJid,
      total: activeSessions.length
    });

    for (let i = 0; i < activeSessions.length; i++) {
      const sessionId = activeSessions[i];
      const sock = this.sessionManager.getSocket(sessionId);

      if (!sock) {
        results.push({ sessionId, success: false, error: 'Socket not connected' });
        continue;
      }

      try {
        // Anti-ban human jitter
        if (i > 0) {
          await AntiBanGuard.jitter(minDelay, maxDelay);
        }

        // Simulate typing if requested
        if (simulateTyping) {
          await sock.sendPresenceUpdate('composing', targetJid);
          await AntiBanGuard.jitter(800, 1500);
          await sock.sendPresenceUpdate('paused', targetJid);
        }

        // Process message with spintax for randomized variation
        const personalizedText = AntiBanGuard.parseSpintax(message);

        const sentMsg = await sock.sendMessage(targetJid, { text: personalizedText });

        results.push({
          sessionId,
          success: true,
          messageId: sentMsg?.key?.id,
          sentText: personalizedText
        });

        this.emitter.emit('action_progress', {
          actionId,
          sessionId,
          current: i + 1,
          total: activeSessions.length,
          status: 'success'
        });
      } catch (err) {
        results.push({ sessionId, success: false, error: err.message });
        this.emitter.emit('action_progress', {
          actionId,
          sessionId,
          current: i + 1,
          total: activeSessions.length,
          status: 'failed',
          error: err.message
        });
      }
    }

    this.emitter.emit('action_completed', {
      actionId,
      type: 'send_message',
      results
    });

    return { actionId, results };
  }

  /**
   * Mirrors group invite acceptance across all active accounts.
   * @param {Object} params
   * @param {string} params.inviteLink - WhatsApp group invite link or code
   * @param {string[]} [params.sessionIds]
   * @param {number} [params.minDelay=1500]
   * @param {number} [params.maxDelay=3500]
   */
  async mirrorJoinGroup({
    inviteLink,
    sessionIds = null,
    minDelay = 1500,
    maxDelay = 3500
  }) {
    if (!inviteLink) throw new Error('Invite link or code is required');

    // Extract code from link if full URL provided
    const match = inviteLink.match(/chat\.whatsapp\.com\/([0-9A-Za-z_-]+)/);
    const inviteCode = match ? match[1] : inviteLink.trim();

    const activeSessions = sessionIds && sessionIds.length > 0
      ? sessionIds
      : this.sessionManager.getConnectedSessionIds();

    if (activeSessions.length === 0) {
      throw new Error('No connected sessions available to join group');
    }

    const actionId = `grp_${Date.now()}`;
    const results = [];

    this.emitter.emit('action_started', {
      actionId,
      type: 'join_group',
      inviteCode,
      total: activeSessions.length
    });

    for (let i = 0; i < activeSessions.length; i++) {
      const sessionId = activeSessions[i];
      const sock = this.sessionManager.getSocket(sessionId);

      if (!sock) {
        results.push({ sessionId, success: false, error: 'Not connected' });
        continue;
      }

      try {
        if (i > 0) {
          await AntiBanGuard.jitter(minDelay, maxDelay);
        }

        const groupId = await sock.groupAcceptInvite(inviteCode);
        results.push({ sessionId, success: true, groupId });

        this.emitter.emit('action_progress', {
          actionId,
          sessionId,
          current: i + 1,
          total: activeSessions.length,
          status: 'success'
        });
      } catch (err) {
        results.push({ sessionId, success: false, error: err.message });
        this.emitter.emit('action_progress', {
          actionId,
          sessionId,
          current: i + 1,
          total: activeSessions.length,
          status: 'failed',
          error: err.message
        });
      }
    }

    this.emitter.emit('action_completed', { actionId, type: 'join_group', results });
    return { actionId, results };
  }

  /**
   * Mirrors an emoji reaction to a message across active accounts.
   * @param {Object} params
   * @param {string} params.target - Chat JID
   * @param {string} params.messageId - Target message ID
   * @param {string} params.emoji - Emoji (e.g. "❤️", "👍")
   * @param {string[]} [params.sessionIds]
   */
  async mirrorReact({
    target,
    messageId,
    emoji,
    sessionIds = null
  }) {
    const targetJid = AntiBanGuard.sanitizeTarget(target);
    const activeSessions = sessionIds && sessionIds.length > 0
      ? sessionIds
      : this.sessionManager.getConnectedSessionIds();

    if (activeSessions.length === 0) {
      throw new Error('No connected sessions available to react');
    }

    const results = [];
    for (const sessionId of activeSessions) {
      const sock = this.sessionManager.getSocket(sessionId);
      if (!sock) continue;

      try {
        await AntiBanGuard.jitter(500, 1500);
        await sock.sendMessage(targetJid, {
          react: {
            text: emoji,
            key: {
              remoteJid: targetJid,
              id: messageId
            }
          }
        });
        results.push({ sessionId, success: true });
      } catch (err) {
        results.push({ sessionId, success: false, error: err.message });
      }
    }

    return { results };
  }
}
