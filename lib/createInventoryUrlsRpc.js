/**
 * Cadastro de URLs por RPC dentro da aba logada do robô (card 132870, D1).
 * Embrulho fino do runInventoryUrls (lib/inventoryUrlsRpc.js): o `fetch` roda no
 * Chrome do robô, que é o único dono da sessão. Nunca loga cookie nem XSRF.
 */

const { ensureGAMLogin } = require('./browser');
const { runInventoryUrls } = require('./inventoryUrlsRpc');

const TIMEOUT_MS = 30_000;
const BASE = 'https://admanager.google.com';

/** fetch dentro da página; devolve { status, text, redirected } ou lança Error com .code TIMEOUT/NETWORK. */
async function pageFetch(page, url, init) {
  const r = await page.evaluate(
    async ({ url, init, timeoutMs }) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...init, credentials: 'include', redirect: 'manual', signal: ctrl.signal });
        const redirected = res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
        return { status: res.status, text: redirected ? '' : await res.text(), redirected };
      } catch (e) {
        return { error: e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK' };
      } finally {
        clearTimeout(timer);
      }
    },
    { url, init, timeoutMs: TIMEOUT_MS }
  );
  if (r.error) {
    const err = new Error(r.error);
    err.code = r.error;
    throw err;
  }
  return r;
}

/**
 * @returns o resultado do runInventoryUrls: { created, skipped, failed, reactivated, pending,
 *   fallbackReason, contractDetail?, contractWarning?, log }. `pending` = URLs sem resultado
 *   (o server as manda ao formulário).
 */
async function createInventoryUrlsRpc(page, { networkId, urls, tag = '', onProgress, reactivate = false }) {
  if (!/^\d+$/.test(String(networkId))) throw new Error('networkId inválido');
  const prefix = tag ? `[${tag}]` : '[url-job]';
  return runInventoryUrls({
    urls,
    reactivate,
    onProgress,
    log: (m) => console.log(`${prefix} [rpc] ${m}`),
    bootstrap: () => pageFetch(page, `${BASE}/${networkId}?hl=en`, { method: 'GET' }),
    call: ({ service, methodName, method, params, xsrf }) =>
      pageFetch(
        page,
        `${BASE}/dfp/v2/inventory/rpc/${service}?methodName=${methodName}&networkCode=${networkId}&authuser=0&hl=en`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json;charset=UTF-8',
            'x-framework-xsrf-token': xsrf,
            'x-jspb-rpc-method': method,
          },
          body: JSON.stringify({ method, params }),
        }
      ),
    // Navega de verdade, com espera curta (não os 3 min de login humano).
    recheckSession: () => ensureGAMLogin(page, networkId, 5_000),
  });
}

module.exports = { createInventoryUrlsRpc };
