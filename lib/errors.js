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

/** O GAM mudou a chamada RPC (resposta fora do formato conhecido): o cadastro volta para o formulário. */
class GamContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GamContractError';
  }
}

/** Sessão do GAM caída (o robô não está logado). */
class GamLoginError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GamLoginError';
  }
}

/** Robô logado, mas sem acesso à rede ou com o XSRF recusado: erro do job, sem volta para o formulário. */
class GamAccessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GamAccessError';
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

module.exports = { BrowserWedgedError, GamContractError, GamLoginError, GamAccessError, isWedgeError };
