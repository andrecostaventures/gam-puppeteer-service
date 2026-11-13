/**
 * Cadastro de URLs do inventário do GAM por RPC (card 132870).
 *
 * Módulo PURO: não depende de puppeteer, de ./nav, de ./browser nem de
 * gam-config-puppeteer, para rodar em `node --test`. O transporte (fetch dentro
 * da aba logada do robô) entra por `call`, `bootstrap` e `recheckSession`
 * (ver lib/createInventoryUrlsRpc.js).
 *
 * Fluxo: lê o que já existe (filtrado pelos domínios da lista) → cadastra em
 * lote só o que falta (D2) → relê para confirmar. Nunca loga cookie, token XSRF
 * nem corpo de resposta inteiro.
 */

const { GamContractError, GamLoginError, GamAccessError } = require('./errors');

// Display/CONTENT e BRANDED: iguais às URLs cadastradas pelo formulário.
const INVENTORY_TYPE_CONTENT = 855711302;
const BRAND_TYPE_BRANDED = 1669513305;

const BLOCK_SIZE = 50;
const PAGE_SIZE = 500;
const LOGIN_MSG = 'Timeout de login: ninguém fez login no GAM em 3 minutos. Tente novamente.';
const URL_CHARS = /^[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]+$/;
const HOST_CHARS = /^[a-z0-9.-]+$/;

/** Falha passageira (tempo esgotado, 5xx, 429). */
class TransientError extends Error {}
/** Sinal de sessão/XSRF ruim (401/403, redirect, fetch com TypeError). */
class SessionError extends Error {
  constructor(status) {
    super(`sessão? ${status}`);
    this.status = status;
  }
}

/** Tira protocolo e barra final; mantém caixa e `www` (nome que sai no relatório). */
function normalizeUrl(url) {
  return String(url || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

/** Mesma chave do `inventoryUrlKey` da API: a unicidade do GAM ignora caixa e mantém `www`. */
function inventoryKey(url) {
  return normalizeUrl(url).toLowerCase();
}

function extractXsrf(html) {
  const m = /xsrfToken\s*:\s*'([^']+)'/.exec(String(html || ''));
  return m ? m[1] : null;
}

/** Tira o prefixo `)]}'` e faz o parse; qualquer outra coisa é contrato alterado. */
function parseRpcBody(text) {
  const clean = String(text || '').replace(/^\s*\)\]\}'\s*/, '');
  try {
    return JSON.parse(clean);
  } catch {
    throw new GamContractError('resposta do GAM não é JSON');
  }
}

const rid = () => String(Math.floor(Math.random() * 1e17)) + String(Date.now());

function buildCreateParams(urls) {
  return {
    2: { 1119: rid() },
    747: urls.map((u) => ({
      1006: u,
      2142: INVENTORY_TYPE_CONTENT,
      2494: true,
      3040: BRAND_TYPE_BRANDED,
    })),
  };
}

function buildSelectParams(pql) {
  return { 2: { 1119: rid() }, 2411: { 1981: pql, 3164: { 3211: true } } };
}

/** ids = só dígitos (vêm da leitura). activate=false desativa. */
function buildActionParams(ids, activate) {
  return {
    2: { 1119: rid() },
    809: activate ? { 49: {} } : { 2865: {} },
    2681: { 1981: `WHERE Id IN(${ids.join(',')}) ORDER BY Url ASC LIMIT ${ids.length} OFFSET 0` },
  };
}

const isNotUnique = (e) => e.index != null && /NOT_UNIQUE$/.test(e.code);

function decodeCreate(json) {
  const r = json && json.result;
  if (!r || typeof r !== 'object') throw new GamContractError('createUrls sem result');
  if (Array.isArray(r['1279'])) {
    const created = r['1279'].map((x, index) => {
      if (!x || x['3473'] == null) throw new GamContractError('createUrls sem id criado');
      return { index, id: String(x['3473']) };
    });
    return { created, notUnique: [], errors: [] };
  }
  const e = r['2428'];
  if (e && typeof e === 'object') {
    const list = e['2127'] && e['2127']['517'];
    const errors = (Array.isArray(list) ? list : []).map((item) => {
      const d = (item && item['1715']) || {};
      const inner = d['1386'] || {};
      const m = /\[(\d+)\]/.exec(String(inner['2869'] || ''));
      return {
        index: m ? Number(m[1]) : null,
        code: String(inner['1467'] || 'UNKNOWN'),
        text: String(d['3893'] || '').slice(0, 200),
      };
    });
    if (!errors.length) {
      errors.push({ index: null, code: 'UNKNOWN', text: String(e['2286'] || '').slice(0, 200) });
    }
    const notUnique = errors.filter(isNotUnique).map((x) => x.index);
    return { created: [], notUnique, errors };
  }
  throw new GamContractError('createUrls fora do formato conhecido');
}

function decodeSelect(json) {
  const r = json && json.result;
  if (!r || typeof r !== 'object') throw new GamContractError('leitura sem result');
  if (r['1677']) throw new GamContractError('consulta de leitura recusada pelo GAM');
  const t = r['3494'];
  const cols = t && Array.isArray(t['246']) ? t['246'].map((c) => c && c['3318']) : null;
  if (!cols) throw new GamContractError('leitura sem colunas');
  const idx = { id: cols.indexOf('id'), url: cols.indexOf('url'), active: cols.indexOf('active') };
  if (Object.values(idx).some((i) => i < 0)) {
    throw new GamContractError('leitura sem as colunas id/url/active');
  }
  const rawRows = Array.isArray(t['1888']) ? t['1888'] : [];
  const rows = rawRows.map((row) => {
    const cells = row && row['1896'];
    const id = cells && cells[idx.id] && cells[idx.id]['1807'] && cells[idx.id]['1807']['1100'];
    const url = cells && cells[idx.url] && cells[idx.url]['3209'] && cells[idx.url]['3209']['3184'];
    const active = cells && cells[idx.active] && cells[idx.active]['2383'] && cells[idx.active]['2383']['1426'];
    if (id == null || url == null || typeof active !== 'boolean') {
      throw new GamContractError('linha de leitura fora do formato');
    }
    return { id: String(id), url: String(url), active };
  });
  return { rows, total: Number.isFinite(Number(t['3805'])) ? Number(t['3805']) : rows.length };
}

const hostOf = (name) => name.split(/[/?#]/)[0].toLowerCase();

/**
 * @param {object} o
 * @param {string[]} o.urls
 * @param {(r:{service:string,methodName:string,method:string,params:object,xsrf:string})=>Promise<{status:number,text:string,redirected?:boolean}>} o.call
 *   transporte; em falha de rede lança Error com `.code` = 'TIMEOUT' | 'NETWORK'
 * @param {()=>Promise<{status:number,text:string,redirected?:boolean}>} o.bootstrap GET /<rede>?hl=en
 * @param {()=>Promise<boolean>} o.recheckSession reconfere a sessão navegando de verdade
 * @param {boolean} [o.reactivate] D3: ativa URL inativa (INVENTORY_URLS_REACTIVATE)
 * @returns {Promise<{created:string[],skipped:string[],failed:{url:string,error:string}[],reactivated:string[],
 *   pending:string[],fallbackReason:null|'contract'|'transient',contractDetail?:string,contractWarning?:string,log:string[]}>}
 */
async function runInventoryUrls({ urls, call, bootstrap, recheckSession, reactivate = false, onProgress, log: sink }) {
  const log = [];
  const L = (m) => {
    log.push(m);
    if (sink) sink(m);
  };

  const items = [];
  const result = new Map(); // key -> { kind, id?, error? }
  for (const raw of urls || []) {
    const name = normalizeUrl(raw);
    const key = name.toLowerCase();
    if (!name || result.has(key) || items.some((i) => i.key === key)) continue;
    if (!URL_CHARS.test(name) || !HOST_CHARS.test(hostOf(name))) {
      result.set(key, { name, kind: 'failed', error: 'URL inválida' });
      continue;
    }
    items.push({ name, key });
  }
  const ordered = [...items];
  for (const [key, v] of result) if (!ordered.some((i) => i.key === key)) ordered.push({ name: v.name, key });

  const set = (it, v) => result.set(it.key, { name: it.name, ...v });
  const fail = (it, error) => set(it, { kind: 'failed', error });
  const report = () => {
    if (!onProgress) return;
    const vals = [...result.values()];
    const n = (k) => vals.filter((v) => v.kind === k).length;
    onProgress({
      done: vals.filter((v) => v.kind !== 'react-pending').length,
      total: ordered.length,
      created: n('created') + n('reactivated'),
      skipped: n('skipped'),
      failed: n('failed'),
    });
  };

  let xsrf = null;
  let contractWarning;

  // ── transporte ──────────────────────────────────────────────────────────
  async function raw(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e && e.code === 'TIMEOUT') throw new TransientError('tempo esgotado');
      if (e && e.code === 'NETWORK') throw new SessionError('rede');
      throw e; // travamento do Chrome etc. segue como erro do job
    }
  }

  async function loadXsrf() {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await raw(bootstrap);
        if (r.status === 429 || r.status >= 500) throw new TransientError(`HTTP ${r.status}`);
        if (r.redirected || r.status === 401 || r.status === 403 || (r.status >= 400 && r.status < 500)) {
          if (!(await recheckSession())) throw new GamLoginError(LOGIN_MSG);
          throw new GamAccessError(`sem acesso à rede ou XSRF recusado: ${r.status}`);
        }
        xsrf = extractXsrf(r.text);
        if (!xsrf) {
          if (!(await recheckSession())) throw new GamLoginError(LOGIN_MSG);
          throw new GamContractError('HTML da rede sem xsrfToken');
        }
        return;
      } catch (e) {
        if (e instanceof SessionError) {
          if (!(await recheckSession())) throw new GamLoginError(LOGIN_MSG);
          throw new GamAccessError('sem acesso à rede ou XSRF recusado: rede');
        }
        if (e instanceof TransientError && attempt === 0) continue;
        throw e;
      }
    }
  }

  async function send(service, methodName, method, params) {
    const r = await raw(() => call({ service, methodName, method, params, xsrf }));
    if (r.redirected || r.status === 401 || r.status === 403) throw new SessionError(r.status);
    if (r.status === 429 || r.status >= 500) throw new TransientError(`HTTP ${r.status}`);
    if (r.status !== 200) throw new GamContractError(`HTTP ${r.status}`);
    const json = parseRpcBody(r.text);
    if (!json || json.error) {
      const e = new GamContractError('resposta do GAM com error');
      e.refused = true;
      throw e;
    }
    if (!json.result) throw new GamContractError('resposta do GAM sem result');
    return json;
  }

  const ensureSession = async () => {
    if (!(await recheckSession())) throw new GamLoginError(LOGIN_MSG);
    await loadXsrf();
  };

  /** Com sessão ruim: reconfere, refaz o XSRF e repete uma vez; se repetir, erro do job. */
  async function withSession(fn) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof SessionError)) throw e;
    }
    await ensureSession();
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SessionError) {
        throw new GamAccessError(`sem acesso à rede ou XSRF recusado: ${e.status}`);
      }
      throw e;
    }
  }

  /** Leitura: uma nova tentativa se passageira. */
  async function readRpc(service, methodName, method, params) {
    const go = () => withSession(() => send(service, methodName, method, params()));
    try {
      return await go();
    } catch (e) {
      if (e instanceof TransientError) return go();
      throw e;
    }
  }

  async function readAll(domains) {
    const map = new Map();
    for (const d of domains) {
      let offset = 0;
      let total = Infinity;
      while (offset < total) {
        const pql = `SELECT Id, Url, Active FROM inventory_url WHERE Url LIKE '${d}%' ORDER BY Id ASC LIMIT ${PAGE_SIZE} OFFSET ${offset}`;
        const page = decodeSelect(
          await readRpc('PublisherQueryLanguageService', 'select_inventoryurl', 'select', () => buildSelectParams(pql))
        );
        if (offset === 0) total = page.total; // se mudar no meio (outro job), segue com o que leu
        for (const r of page.rows) map.set(inventoryKey(r.url), r);
        if (!page.rows.length) break;
        offset += PAGE_SIZE;
      }
    }
    return map;
  }

  // ── escrita (D2) ────────────────────────────────────────────────────────
  const markCreated = (it, id) => set(it, { kind: 'created', id });

  /** Uma chamada de createUrls. Passageira = sem resultado (a releitura decide). */
  async function tryCreate(block, domains) {
    const go = async (its) => decodeCreate(await send('UrlService', 'createUrls', 'createUrls', buildCreateParams(its.map((i) => i.name))));
    try {
      return { res: await go(block), items: block };
    } catch (e) {
      if (e instanceof TransientError) return { res: null, items: block };
      if (!(e instanceof SessionError)) throw e;
    }
    // Sessão ruim na escrita: a releitura decide antes de repetir.
    await ensureSession();
    const found = await readAll(domains);
    const missing = [];
    for (const it of block) {
      const row = found.get(it.key);
      if (row) markCreated(it, row.id);
      else missing.push(it);
    }
    if (!missing.length) return { res: null, items: [] };
    try {
      return { res: await go(missing), items: missing };
    } catch (e) {
      if (e instanceof SessionError) throw new GamAccessError(`sem acesso à rede ou XSRF recusado: ${e.status}`);
      if (e instanceof TransientError) return { res: null, items: missing };
      throw e;
    }
  }

  async function writeBlock(block, domains, depth) {
    const { res, items: its } = await tryCreate(block, domains);
    if (!res) return;
    res.created.forEach((c) => markCreated(its[c.index], c.id));
    res.notUnique.forEach((i) => set(its[i], { kind: 'skipped' }));
    const rest = its.filter((it) => !result.has(it.key));
    if (!rest.length) return;
    const others = res.errors.filter((e) => !isNotUnique(e));
    if (its.length === 1) {
      const e = others[0] || res.errors[0];
      fail(its[0], e ? `${e.code}: ${e.text}` : 'o GAM não devolveu resultado para a URL');
      return;
    }
    if (depth === 0 && !others.length && res.notUnique.length) return writeBlock(rest, domains, 1);
    for (const it of rest) await writeBlock([it], domains, 2);
  }

  // ── reativação (D3) ─────────────────────────────────────────────────────
  async function reactivateAll(inactive) {
    for (let i = 0; i < inactive.length; i += BLOCK_SIZE) {
      const chunk = inactive.slice(i, i + BLOCK_SIZE);
      const failAll = (motivo) => chunk.forEach(({ it }) => fail(it, `ativar à mão: ${motivo}`));
      try {
        const json = await withSession(() =>
          send('UrlService', 'performUrlAction', 'performUrlAction', buildActionParams(chunk.map((c) => c.row.id), true))
        );
        const n = json.result['2495'] && json.result['2495']['2498'];
        if (typeof n !== 'number') {
          contractWarning = 'O GAM mudou a chamada de ativar URL (resposta não reconhecida). As URLs inativas ficaram como falha. Avise o time de dev.';
          failAll('resposta não reconhecida');
        } else {
          chunk.forEach(({ it }) => set(it, { kind: 'react-pending' }));
        }
      } catch (e) {
        if (e instanceof GamLoginError || e instanceof GamAccessError) throw e;
        if (e instanceof TransientError) failAll(`GAM indisponível (${e.message})`);
        else if (e instanceof GamContractError) {
          if (!e.refused) {
            contractWarning = `O GAM mudou a chamada de ativar URL (${e.message}). As URLs inativas ficaram como falha. Avise o time de dev.`;
          }
          failAll(e.refused ? 'o GAM recusou a ativação' : e.message);
        } else throw e;
      }
    }
  }

  // ── execução ────────────────────────────────────────────────────────────
  async function work() {
    const domains = [...new Set(items.map((i) => hostOf(i.name)))];
    const existing = await readAll(domains);
    const todo = [];
    const inactive = [];
    for (const it of items) {
      const row = existing.get(it.key);
      if (!row) todo.push(it);
      else if (row.active) set(it, { kind: 'skipped' });
      else inactive.push({ it, row });
    }
    L(`Leitura: ${items.length - todo.length - inactive.length} já ativas, ${inactive.length} inativas, ${todo.length} a cadastrar`);
    report();

    if (inactive.length) {
      if (reactivate) await reactivateAll(inactive);
      else inactive.forEach(({ it }) => fail(it, 'URL existe inativa no GAM; ativar à mão'));
    }
    for (let i = 0; i < todo.length; i += BLOCK_SIZE) {
      await writeBlock(todo.slice(i, i + BLOCK_SIZE), domains, 0);
      report();
    }

    const vals = () => [...result.values()];
    const needsReread =
      vals().some((v) => v.kind === 'created' || v.kind === 'react-pending') ||
      todo.some((it) => !result.has(it.key));
    if (!needsReread) return;
    const after = await readAll(domains);
    for (const it of items) {
      const v = result.get(it.key);
      const row = after.get(it.key);
      if (!v) {
        if (row) markCreated(it, row.id); // escrita passageira que o GAM aceitou
      } else if (v.kind === 'created' && !row) {
        fail(it, 'o GAM confirmou, mas a URL não apareceu na releitura');
      } else if (v.kind === 'react-pending') {
        if (row && row.active) set(it, { kind: 'reactivated' });
        else fail(it, 'ativar à mão: o GAM não confirmou a ativação');
      }
    }
    report();
  }

  let fallbackReason = null;
  let contractDetail;
  try {
    if (items.length) {
      await loadXsrf();
      await work();
    }
  } catch (e) {
    if (e instanceof GamContractError) {
      fallbackReason = 'contract';
      contractDetail = String(e.message).slice(0, 120);
      L(`Contrato alterado: ${contractDetail}`);
    } else if (e instanceof TransientError) {
      fallbackReason = 'transient';
      L(`Falha passageira do GAM: ${e.message}`);
    } else throw e;
  }
  // Inativa nunca vai para o formulário: sem confirmação, vira falha.
  for (const it of items) {
    const v = result.get(it.key);
    if (v && v.kind === 'react-pending') fail(it, 'ativar à mão: não foi possível confirmar a ativação');
  }
  report();

  const pick = (k) => ordered.filter((it) => result.get(it.key) && result.get(it.key).kind === k);
  const failed = pick('failed').map((it) => ({ url: it.name, error: result.get(it.key).error }));
  const out = {
    created: pick('created').map((i) => i.name),
    skipped: pick('skipped').map((i) => i.name),
    failed,
    reactivated: pick('reactivated').map((i) => i.name),
    pending: ordered.filter((it) => !result.has(it.key)).map((i) => i.name),
    fallbackReason,
    log,
  };
  if (contractDetail) out.contractDetail = contractDetail;
  if (contractWarning) out.contractWarning = contractWarning;
  return out;
}

module.exports = {
  INVENTORY_TYPE_CONTENT,
  BRAND_TYPE_BRANDED,
  BLOCK_SIZE,
  normalizeUrl,
  inventoryKey,
  extractXsrf,
  parseRpcBody,
  buildCreateParams,
  buildSelectParams,
  buildActionParams,
  decodeCreate,
  decodeSelect,
  runInventoryUrls,
};
