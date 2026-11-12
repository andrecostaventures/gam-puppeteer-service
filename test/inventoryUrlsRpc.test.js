const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/inventoryUrlsRpc');
const { GamContractError, GamLoginError, GamAccessError } = require('../lib/errors');
const res = require('./fixtures/resultado.json'); // respostas reais do spike (12/11/2026)
const variantes = require('./fixtures/variantes.json'); // etapa 0: caminho, www, maiúsculas

// ── GAM falso, com estado ──────────────────────────────────────────────────
const nuJson = (indices, code = 'UniqueError.NOT_UNIQUE', text = 'Field is not unique.') => ({
  result: {
    2428: {
      2127: {
        517: indices.map((i) => ({
          1715: { 1386: { 1467: code, 2869: `[${i}].url` }, 3893: text },
        })),
      },
    },
  },
});
const okJson = (ids) => ({ result: { 1279: ids.map((id) => ({ 3473: String(id) })) } });
const cell = (r) => ({
  1896: [{ 1807: { 1100: r.id } }, { 3209: { 3184: r.url } }, { 2383: { 1426: r.active } }],
});
const selectJson = (rows, total) => ({
  result: {
    3494: {
      246: [{ 3318: 'id' }, { 3318: 'url' }, { 3318: 'active' }],
      1888: rows.map(cell),
      3805: total,
    },
  },
});
const reply = (json, status = 200) => ({ status, text: ")]}'\n" + JSON.stringify(json) });
const codeErr = (code) => Object.assign(new Error(code), { code });

function fake(initial = [], hooks = {}) {
  let nextId = 1000;
  const store = new Map(); // key -> {id,url,active}
  for (const x of initial) {
    const url = typeof x === 'string' ? x : x.url;
    store.set(m.inventoryKey(url), { id: String(nextId++), url, active: x.active !== false });
  }
  const calls = [];
  const f = {
    store,
    calls,
    count: (name) => calls.filter((c) => c.methodName === name).length,
    bootstrap: async () => (hooks.bootstrap ? hooks.bootstrap() : { status: 200, text: "x xsrfToken: 'tok123' y" }),
    recheckSession: async () => (hooks.recheck ? hooks.recheck() : true),
    call: async (req) => {
      calls.push({ methodName: req.methodName, params: req.params, xsrf: req.xsrf });
      if (hooks.before) {
        const r = await hooks.before(req, calls.length, f);
        if (r !== undefined) return r;
      }
      if (req.methodName === 'createUrls') {
        const urls = req.params[747].map((x) => x[1006]);
        const dups = urls.map((u, i) => (store.has(m.inventoryKey(u)) ? i : -1)).filter((i) => i >= 0);
        if (dups.length) return reply(nuJson(dups));
        const ids = urls.map((u) => {
          const id = String(nextId++);
          if (!hooks.dropCreates) store.set(m.inventoryKey(u), { id, url: u, active: true });
          return id;
        });
        return reply(okJson(ids));
      }
      if (req.methodName === 'select_inventoryurl') {
        const pql = req.params[2411][1981];
        const like = /LIKE '([^%]*)%'/.exec(pql)[1];
        const off = Number(/OFFSET (\d+)/.exec(pql)[1]);
        const lim = Number(/LIMIT (\d+)/.exec(pql)[1]);
        const all = [...store.values()].filter((r) => m.inventoryKey(r.url).startsWith(like));
        return reply(selectJson(all.slice(off, off + lim), all.length));
      }
      if (req.methodName === 'performUrlAction') {
        const ids = /IN\(([^)]*)\)/.exec(req.params[2681][1981])[1].split(',');
        if (!hooks.noFlip) for (const r of store.values()) if (ids.includes(r.id)) r.active = true;
        return reply({ result: { 2495: { 2498: ids.length } } });
      }
      throw new Error('chamada inesperada ' + req.methodName);
    },
  };
  return f;
}
const run = (f, urls, extra = {}) =>
  m.runInventoryUrls({ urls, call: f.call, bootstrap: f.bootstrap, recheckSession: f.recheckSession, ...extra });
const onlySelect = (bad) => ({
  before: async (req) => (req.methodName === 'select_inventoryurl' ? bad : undefined),
});

// ── puro: fixtures reais ───────────────────────────────────────────────────
test('decodeCreate: criado, repetido sozinho, lote com repetida e lote de 2 novas', () => {
  assert.deepEqual(m.decodeCreate(m.parseRpcBody(res.t2_cria_1_nova.body)).created, [{ index: 0, id: '1593453812' }]);
  const rep = m.decodeCreate(m.parseRpcBody(res.t3_repete_a_mesma.body));
  assert.deepEqual(rep.notUnique, [0]);
  assert.equal(rep.errors[0].code, 'UniqueError.NOT_UNIQUE');
  assert.deepEqual(m.decodeCreate(m.parseRpcBody(res.t4_lote_nova_e_repetida.body)).notUnique, [1]);
  assert.equal(m.decodeCreate(m.parseRpcBody(res.t5_lote_2_novas.body)).created.length, 2);
});

test('decodeCreate: variantes da etapa 0 (caminho, www, maiúsculas)', () => {
  for (const k of ['c1_caminho_barra', 'c2_caminho_sem_barra', 'c3_www', 'c4_maiusc', 'r3_sem_www_de_c3']) {
    assert.equal(m.decodeCreate(m.parseRpcBody(variantes[k].body)).created.length, 1, k);
  }
  for (const k of ['r1_sem_barra_de_c1', 'r2_com_barra_de_c2', 'r4_minusc_de_c4', 'r5_https_de_c2']) {
    assert.deepEqual(m.decodeCreate(m.parseRpcBody(variantes[k].body)).notUnique, [0], k);
  }
});

test('decodeSelect: colunas id/url/active e total; sem colunas = contrato', () => {
  const d = m.decodeSelect(m.parseRpcBody(res.t6_confere.body));
  assert.equal(d.total, 3);
  assert.equal(d.rows.length, 3);
  assert.deepEqual(Object.keys(d.rows[0]), ['id', 'url', 'active']);
  assert.equal(d.rows[0].active, true);
  const j = m.parseRpcBody(res.t6_confere.body);
  j.result['3494']['246'] = [{ 3318: 'id' }, { 3318: 'url' }];
  assert.throws(() => m.decodeSelect(j), GamContractError);
});

test('parseRpcBody tira o prefixo de proteção e extractXsrf lê o token', () => {
  assert.deepEqual(m.parseRpcBody(")]}'\n{\"a\":1}"), { a: 1 });
  assert.deepEqual(m.parseRpcBody('{"a":1}'), { a: 1 });
  assert.throws(() => m.parseRpcBody('<html>'), GamContractError);
  assert.equal(m.extractXsrf("window.x = { xsrfToken: 'abc:123' }"), 'abc:123');
  assert.equal(m.extractXsrf('<html>sem token</html>'), null);
});

test('resposta desconhecida do createUrls = GamContractError', () => {
  assert.throws(() => m.decodeCreate({ result: { 9999: {} } }), GamContractError);
  assert.throws(() => m.decodeCreate({}), GamContractError);
});

test('inventoryKey = inventoryUrlKey da API (sem protocolo, sem barra, minúsculas, mantém www)', () => {
  assert.equal(m.inventoryKey('https://WWW.Site.com/Artigo/'), 'www.site.com/artigo');
  assert.equal(m.inventoryKey(' http://site.com// '), 'site.com');
  assert.notEqual(m.inventoryKey('www.site.com'), m.inventoryKey('site.com'));
  assert.equal(m.normalizeUrl('https://Site.com/Artigo-Quatro/'), 'Site.com/Artigo-Quatro');
});

test('buildCreateParams usa CONTENT e BRANDED', () => {
  const p = m.buildCreateParams(['a.com']);
  assert.equal(p[747][0][2142], 855711302);
  assert.equal(p[747][0][3040], 1669513305);
  assert.equal(p[747][0][2494], true);
});

// ── fluxo ──────────────────────────────────────────────────────────────────
test('reenviar URLs que já existem: tudo "já existia", sem createUrls', async () => {
  const f = fake(['a.com', 'a.com/x', 'www.b.com/y']);
  const r = await run(f, ['https://a.com/', 'A.com/x/', 'www.b.com/y']);
  assert.equal(r.skipped.length, 3);
  assert.equal(r.created.length + r.failed.length + r.pending.length, 0);
  assert.equal(f.count('createUrls'), 0);
  assert.equal(r.fallbackReason, null);
});

test('mistura: cria as novas com caminho, pula as existentes, confirma na releitura', async () => {
  const f = fake(['old.com/a']);
  const r = await run(f, ['old.com/a', 'new.com/Artigo-Um/', 'www.new.com/dois']);
  assert.deepEqual(r.created, ['new.com/Artigo-Um', 'www.new.com/dois']);
  assert.deepEqual(r.skipped, ['old.com/a']);
  assert.equal(f.count('createUrls'), 1);
  assert.equal(f.count('select_inventoryurl'), 6); // 3 domínios × (leitura + releitura)
  assert.equal(f.calls[0].xsrf, 'tok123');
});

test('120 novas = blocos de 50, 50 e 20', async () => {
  const f = fake();
  const urls = Array.from({ length: 120 }, (_, i) => `s${i}.com/p`);
  const r = await run(f, urls);
  assert.equal(r.created.length, 120);
  assert.deepEqual(
    f.calls.filter((c) => c.methodName === 'createUrls').map((c) => c.params[747].length),
    [50, 50, 20]
  );
});

test('D2: outro job cadastrou uma no meio — repetida vira "já existia" e o resto é reenviado uma vez', async () => {
  let first = true;
  const f = fake([], {
    before: async (req, n, g) => {
      if (req.methodName === 'createUrls' && first) {
        first = false;
        g.store.set('b.com', { id: '1', url: 'b.com', active: true }); // concorrente
      }
    },
  });
  const r = await run(f, ['a.com', 'b.com', 'c.com']);
  assert.deepEqual(r.created, ['a.com', 'c.com']);
  assert.deepEqual(r.skipped, ['b.com']);
  assert.equal(f.count('createUrls'), 2);
});

test('D2: recusa que se repete cai para uma URL por chamada', async () => {
  let n = 0;
  const f = fake([], {
    before: async (req, _c, g) => {
      if (req.methodName === 'createUrls' && n < 2) {
        n++;
        const u = req.params[747][n - 1][1006]; // a cada tentativa, um concorrente cadastra mais uma
        g.store.set(m.inventoryKey(u), { id: String(n), url: u, active: true });
      }
    },
  });
  const r = await run(f, ['a.com', 'b.com', 'c.com', 'd.com']);
  assert.equal(r.skipped.length, 2);
  assert.equal(r.created.length, 2);
  // 1 lote + 1 reenvio + 2 unitárias (as 2 restantes)
  assert.equal(f.count('createUrls'), 4);
});

test('erro de validação do GAM: uma por chamada, falha com código e texto', async () => {
  const f = fake([], {
    before: async (req) => {
      if (req.methodName === 'createUrls') {
        const u = req.params[747].map((x) => x[1006]);
        if (u.includes('bad.com')) return reply(nuJson([u.indexOf('bad.com')], 'CommonError.INVALID', 'Valor inválido'));
      }
    },
  });
  const r = await run(f, ['ok.com', 'bad.com']);
  assert.deepEqual(r.created, ['ok.com']);
  assert.deepEqual(r.failed, [{ url: 'bad.com', error: 'CommonError.INVALID: Valor inválido' }]);
});

test('escrita com tempo esgotado: a releitura decide (aceita → criada; não aceita → pendente)', async () => {
  const f1 = fake([], {
    before: async (req, _n, g) => {
      if (req.methodName === 'createUrls') {
        const u = req.params[747][0][1006];
        g.store.set(m.inventoryKey(u), { id: '9', url: u, active: true });
        throw codeErr('TIMEOUT');
      }
    },
  });
  const r1 = await run(f1, ['a.com']);
  assert.deepEqual(r1.created, ['a.com']);
  assert.equal(r1.pending.length, 0);
  assert.equal(f1.count('createUrls'), 1); // sem nova tentativa da escrita

  const f2 = fake([], {
    before: async (req) => (req.methodName === 'createUrls' ? { status: 503, text: '' } : undefined),
  });
  const r2 = await run(f2, ['a.com', 'b.com']);
  assert.deepEqual(r2.pending, ['a.com', 'b.com']);
  assert.equal(f2.count('createUrls'), 1);
});

test('GAM confirmou mas a URL não aparece na releitura = falha com motivo', async () => {
  const f = fake([], { dropCreates: true });
  const r = await run(f, ['a.com']);
  assert.equal(r.created.length, 0);
  assert.match(r.failed[0].error, /não apareceu na releitura/);
});

test('contrato: createUrls desconhecido volta pendente, com detalhe', async () => {
  const f = fake([], {
    before: async (req) => (req.methodName === 'createUrls' ? reply({ result: { 7: 1 } }) : undefined),
  });
  const r = await run(f, ['a.com', 'b.com']);
  assert.equal(r.fallbackReason, 'contract');
  assert.deepEqual(r.pending, ['a.com', 'b.com']);
  assert.match(r.contractDetail, /fora do formato/);
});

test('contrato: leitura sem colunas, JSON inválido, HTTP 200 sem result e com error', async () => {
  for (const bad of [
    reply({ result: { 3494: { 246: [{ 3318: 'id' }], 1888: [] } } }),
    { status: 200, text: '<html>' },
    reply({}),
    reply({ error: { 1: 'x' } }),
  ]) {
    const f = fake([], onlySelect(bad));
    const r = await run(f, ['a.com']);
    assert.equal(r.fallbackReason, 'contract');
    assert.deepEqual(r.pending, ['a.com']);
    assert.equal(f.count('createUrls'), 0);
  }
});

test('bootstrap: HTML sem xsrf (logado) = contrato; deslogado = erro de login', async () => {
  const noTok = { status: 200, text: '<html>nada</html>' };
  const r = await run(fake([], { bootstrap: () => noTok }), ['a.com']);
  assert.equal(r.fallbackReason, 'contract');
  assert.deepEqual(r.pending, ['a.com']);
  await assert.rejects(run(fake([], { bootstrap: () => noTok, recheck: () => false }), ['a.com']), GamLoginError);
});

test('bootstrap 4xx: deslogado = login; logado = sem acesso à rede (sem formulário)', async () => {
  const forbidden = { status: 403, text: '' };
  await assert.rejects(run(fake([], { bootstrap: () => forbidden, recheck: () => false }), ['a.com']), GamLoginError);
  await assert.rejects(run(fake([], { bootstrap: () => forbidden }), ['a.com']), GamAccessError);
});

test('bootstrap 5xx duas vezes = passageiro, tudo pendente, sem aviso de contrato', async () => {
  let n = 0;
  const f = fake([], { bootstrap: () => (n++, { status: 503, text: '' }) });
  const r = await run(f, ['a.com']);
  assert.equal(n, 2);
  assert.equal(r.fallbackReason, 'transient');
  assert.equal(r.contractDetail, undefined);
  assert.deepEqual(r.pending, ['a.com']);
});

test('leitura passageira: uma nova tentativa; esgotada = pendente (transient)', async () => {
  let n = 0;
  const f1 = fake(['a.com'], {
    before: async (req) => (req.methodName === 'select_inventoryurl' && n++ === 0 ? { status: 429, text: '' } : undefined),
  });
  const r1 = await run(f1, ['a.com']);
  assert.deepEqual(r1.skipped, ['a.com']);

  const f2 = fake([], onlySelect({ status: 500, text: '' }));
  const r2 = await run(f2, ['a.com']);
  assert.equal(r2.fallbackReason, 'transient');
  assert.deepEqual(r2.pending, ['a.com']);
  assert.equal(f2.count('select_inventoryurl'), 2);
});

test('sessão: 403 na leitura refaz o XSRF e repete; 403 de novo = sem acesso; deslogado = login', async () => {
  let boots = 0;
  let n = 0;
  const f = fake(['a.com'], {
    bootstrap: () => (boots++, { status: 200, text: `xsrfToken: 'tok${boots}'` }),
    before: async (req) => (req.methodName === 'select_inventoryurl' && n++ === 0 ? { status: 403, text: '' } : undefined),
  });
  const r = await run(f, ['a.com']);
  assert.deepEqual(r.skipped, ['a.com']);
  assert.equal(boots, 2);
  assert.equal(f.calls.at(-1).xsrf, 'tok2');

  await assert.rejects(run(fake([], onlySelect({ status: 403, text: '' })), ['a.com']), GamAccessError);
  const h = fake([], {
    before: async (req) => {
      if (req.methodName === 'select_inventoryurl') throw codeErr('NETWORK');
    },
    recheck: () => false,
  });
  await assert.rejects(run(h, ['a.com']), GamLoginError);
});

test('URL inválida (aspas, caractere fora da lista, host estranho) falha sem chamar o GAM', async () => {
  const f = fake();
  const r = await run(f, ["a.com/x'y", 'a.com/ç', 'bad host.com', 'ok.com']);
  assert.equal(r.failed.length, 3);
  assert.ok(r.failed.every((x) => x.error === 'URL inválida'));
  assert.deepEqual(r.created, ['ok.com']);
  assert.ok(f.calls.every((c) => !JSON.stringify(c.params).includes("x'y")));
});

test('leitura filtrada pelos domínios da lista', async () => {
  const f = fake();
  await run(f, ['A.com/x', 'a.com/y', 'b.com/z']);
  const pqls = f.calls.filter((c) => c.methodName === 'select_inventoryurl').map((c) => c.params[2411][1981]);
  assert.ok(pqls.some((p) => p.includes("LIKE 'a.com%'")));
  assert.ok(pqls.some((p) => p.includes("LIKE 'b.com%'")));
  assert.ok(pqls.every((p) => /ORDER BY Id ASC/.test(p)));
});

test('leitura pagina de 500 em 500 até o total', async () => {
  const initial = Array.from({ length: 1200 }, (_, i) => `d.com/p${i}`);
  const f = fake(initial);
  const r = await run(f, ['d.com/p0', 'd.com/p1199', 'd.com/novo']);
  assert.deepEqual(r.skipped, ['d.com/p0', 'd.com/p1199']);
  assert.deepEqual(r.created, ['d.com/novo']);
  assert.ok(f.calls.filter((c) => c.methodName === 'select_inventoryurl').length >= 3);
});

// ── URL inativa (D3) ───────────────────────────────────────────────────────
test('inativa sem reativação: falha "ativar à mão", nunca vai ao createUrls nem fica pendente', async () => {
  const f = fake([{ url: 'a.com/x', active: false }]);
  const r = await run(f, ['a.com/x', 'b.com']);
  assert.deepEqual(r.failed, [{ url: 'a.com/x', error: 'URL existe inativa no GAM; ativar à mão' }]);
  assert.deepEqual(r.created, ['b.com']);
  assert.equal(r.pending.length, 0);
  assert.equal(f.count('performUrlAction'), 0);
});

test('inativa com reativação: ativa, confirma na releitura e marca "reativada"', async () => {
  const f = fake([{ url: 'a.com/x', active: false }]);
  const r = await run(f, ['a.com/x'], { reactivate: true });
  assert.deepEqual(r.reactivated, ['a.com/x']);
  assert.equal(r.failed.length, 0);
  const act = f.calls.find((c) => c.methodName === 'performUrlAction').params;
  assert.deepEqual(act[809], { 49: {} });
  assert.match(act[2681][1981], /^WHERE Id IN\(1000\) ORDER BY Url ASC LIMIT 1 OFFSET 0$/);
});

test('reativação sem confirmação na releitura = falha', async () => {
  const f = fake([{ url: 'a.com/x', active: false }], { noFlip: true });
  const r = await run(f, ['a.com/x'], { reactivate: true });
  assert.deepEqual(r.reactivated, []);
  assert.match(r.failed[0].error, /ativar à mão: o GAM não confirmou/);
});

test('reativação recusada ou passageira: falha sem aviso; não reconhecida: falha com aviso', async () => {
  const mk = (resp) =>
    fake([{ url: 'a.com/x', active: false }], {
      before: async (req) => (req.methodName === 'performUrlAction' ? resp : undefined),
    });
  const recusada = await run(mk(reply({ error: { 1: 'x' } })), ['a.com/x'], { reactivate: true });
  assert.match(recusada.failed[0].error, /ativar à mão: o GAM recusou/);
  assert.equal(recusada.contractWarning, undefined);

  const passageira = await run(mk({ status: 503, text: '' }), ['a.com/x'], { reactivate: true });
  assert.match(passageira.failed[0].error, /ativar à mão: GAM indisponível/);
  assert.equal(passageira.contractWarning, undefined);

  const desconhecida = await run(mk(reply({ result: { 1: 1 } })), ['a.com/x'], { reactivate: true });
  assert.match(desconhecida.failed[0].error, /ativar à mão: resposta não reconhecida/);
  assert.match(desconhecida.contractWarning, /Avise o time de dev/);
  assert.equal(desconhecida.pending.length, 0);
});

test('a saída não carrega o token XSRF', async () => {
  const f = fake(['a.com']);
  const r = await run(f, ['a.com', 'b.com']);
  assert.ok(!JSON.stringify(r).includes('tok123'));
});
