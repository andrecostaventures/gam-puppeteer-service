/**
 * Erros e detecção de estado "travado" do Chrome.
 *
 * Quando o Chrome fica sem CPU/memória (saturado), o protocolo CDP para de
 * responder e o Puppeteer lança erros como "Runtime.callFunctionOn timed out"
 * ou "Target closed". Nesse estado nada mais funciona até reciclar o navegador.
 */

class BrowserWedgedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowserWedgedError';
  }
}

/** Heurística: o erro indica que o Chrome/CDP travou? */
function isWedgeError(err) {
  const m = String((err && err.message) || err || '').toLowerCase();
  return (
    m.includes('runtime.callfunctionon timed out') ||
    m.includes('protocoltimeout') ||
    m.includes('protocol timeout') ||
    m.includes('target closed') ||
    m.includes('session closed') ||
    m.includes('connection closed') ||
    m.includes('websocket') ||
    m.includes('detached frame')
  );
}

module.exports = { BrowserWedgedError, isWedgeError };
