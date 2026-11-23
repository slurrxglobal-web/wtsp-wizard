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
   * @param {string} target - Target phone number or JID
   * @returns {string} Sanitized WhatsApp JID
   */
  static sanitizeTarget(target) {
    if (!target) return '';
    const cleaned = target.trim();

    // If it's already a group or user JID
    if (cleaned.includes('@s.whatsapp.net') || cleaned.includes('@g.us')) {
      return cleaned;
    }

    // Strip non-numeric characters (plus, dashes, spaces)
    const digitsOnly = cleaned.replace(/\D/g, '');
    return `${digitsOnly}@s.whatsapp.net`;
  }
}
