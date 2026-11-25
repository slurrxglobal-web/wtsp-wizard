/**
 * AntiBanGuard - Safety, human emulation, and jitter controls for multi-session operations.
 */

export class AntiBanGuard {
  /**
   * Generates a random delay between min and max milliseconds.
   * @param {number} minMs - Minimum delay in ms (default: 1000)
   * @param {number} maxMs - Maximum delay in ms (default: 3000)
   * @returns {Promise<number>} Resolves with elapsed delay in ms
   */
  static async jitter(minMs = 1000, maxMs = 3000) {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return delay;
  }

  /**
   * Parses Spintax syntax e.g. "{Hello|Hi|Hey} {friend|bro|there}"
   * and returns a randomized string output.
   * @param {string} text - Spintax template
   * @returns {string} Processed randomized text
   */
  static parseSpintax(text) {
    if (!text || typeof text !== 'string') return '';
    const spintaxRegex = /\{([^{}]+)\}/g;
    let result = text;

    while (spintaxRegex.test(result)) {
      result = result.replace(spintaxRegex, (match, choices) => {
        const options = choices.split('|');
        return options[Math.floor(Math.random() * options.length)].trim();
      });
    }

    return result;
  }

  /**
   * Formats a raw number or string into a valid WhatsApp JID.
   * Rejects malformed strings, alphabets, or empty strings.
   * @param {string} target - Target phone number or JID
   * @returns {string|null} Valid WhatsApp JID or null if invalid
   */
  static sanitizeTarget(target) {
    if (!target || typeof target !== 'string') return null;
    const cleaned = target.trim();
    if (!cleaned) return null;

    // Group JID: digits-digits@g.us or digits@g.us
    if (cleaned.endsWith('@g.us')) {
      const prefix = cleaned.replace('@g.us', '');
      if (/^[0-9-]+$/.test(prefix)) {
        return cleaned;
      }
      return null;
    }

    // Direct WhatsApp User JID: digits@s.whatsapp.net
    if (cleaned.endsWith('@s.whatsapp.net')) {
      const prefix = cleaned.replace('@s.whatsapp.net', '');
      if (/^\d{7,15}$/.test(prefix)) {
        return cleaned;
      }
      return null;
    }

    // Raw Phone number: extract digits (international numbers are 7-15 digits)
    const digitsOnly = cleaned.replace(/\D/g, '');
    if (digitsOnly.length >= 7 && digitsOnly.length <= 15) {
      return `${digitsOnly}@s.whatsapp.net`;
    }

    return null;
  }
}
