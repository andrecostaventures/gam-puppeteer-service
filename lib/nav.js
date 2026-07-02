/**
 * Navegação robusta para URLs do GAM (SPA Angular com roteamento por #hash).
 *
 * O GAM é uma single-page app cujas rotas ficam no fragmento da URL (#...).
 * Quando a página já está no MESMO documento (mesma origin+path, só o #hash
 * muda), page.goto() NÃO dispara uma navegação real de rede — o Chrome trata
 * como same-document navigation e aborta a requisição com net::ERR_ABORTED.
 *
 * Aqui detectamos esse caso e trocamos a rota via roteador client-side
 * (window.location.assign, que dispara o hashchange que o Angular escuta), com
 * fallback caso o goto aborte mesmo assim por uma corrida de timing.
 */
async function gotoGam(page, url, { waitUntil = 'domcontentloaded', timeout = 60000 } = {}) {
  const currentBase = (page.url() || '').split('#')[0];
  const targetBase = url.split('#')[0];

  if (currentBase && currentBase === targetBase) {
    await page.evaluate((u) => { window.location.assign(u); }, url);
    return;
  }

  try {
    await page.goto(url, { waitUntil, timeout });
  } catch (err) {
    if (!String(err && err.message).includes('ERR_ABORTED')) throw err;
    await page.evaluate((u) => { window.location.assign(u); }, url);
  }
}

module.exports = { gotoGam };
