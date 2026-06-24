const express = require('express');
const { getOrStartBrowser, ensureGAMLogin, isBrowserConnected } = require('./lib/browser');
const { createDisplayChannels } = require('./lib/createDisplayChannels');
const { createInventoryUrls } = require('./lib/createInventoryUrls');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3002;

app.get('/health', async (req, res) => {
  const connected = await isBrowserConnected();
  res.json({
    status: 'ok',
    browser: connected ? 'connected' : 'disconnected',
    message: connected
      ? 'Chrome conectado e pronto.'
      : 'Chrome não está rodando. Será iniciado automaticamente ao criar channels.',
  });
});

/**
 * POST /create-display-channels
 * Body: { networkId: string, sources: string[] }
 *
 * Fluxo:
 *  1. Tenta conectar ao Chrome já aberto → se não, abre um novo
 *  2. Navega para o GAM e verifica login
 *  3. Se não logado → aguarda o usuário logar (até 3 min)
 *  4. Executa a criação dos channels
 */
app.post('/create-display-channels', async (req, res) => {
  const { networkId, sources, suffix } = req.body || {};

  if (!networkId || typeof networkId !== 'string') {
    return res.status(400).json({ error: 'networkId é obrigatório' });
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    return res.status(400).json({ error: 'sources deve ser um array não vazio' });
  }

  // 1. Obtém ou inicia o Chrome
  let page;
  try {
    const conn = await getOrStartBrowser();
    page = conn.page;
    if (conn.wasStarted) {
      console.log('[server] Chrome iniciado. Aguardando carregamento...');
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch (e) {
    return res.status(503).json({
      error: `Não foi possível iniciar o Chrome: ${e.message}`,
    });
  }

  // 2. Garante login no GAM (aguarda até 3 min se necessário)
  const loggedIn = await ensureGAMLogin(page, networkId);
  if (!loggedIn) {
    return res.status(408).json({
      error: 'Timeout de login: o usuário não fez login no GAM em 3 minutos. Tente novamente.',
    });
  }

  // 3. Executa a criação dos channels
  try {
    console.log(`[server] Criando channels — networkId=${networkId} suffix=${suffix || 'hs'} sources=${sources.join(', ')}`);
    const result = await createDisplayChannels(page, { networkId, sources, suffix });
    console.log(`[server] Concluído — criados=${result.created.length} pulados=${result.skipped.length}`);

    return res.json({
      created: result.created,
      skipped: result.skipped,
      log: [
        `Criados (${result.created.length}): ${result.created.join(', ') || 'nenhum'}`,
        `Já existiam (${result.skipped.length}): ${result.skipped.join(', ') || 'nenhum'}`,
      ],
    });
  } catch (e) {
    console.error('[server] Erro ao criar channels:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

/**
 * Estado do job de cadastro de URLs (em memória — uma instância só).
 * Listas grandes demoram (cadastro é sequencial na UI), então o processamento
 * roda em segundo plano e o cliente faz polling em GET /create-inventory-urls/:jobId.
 * Isso evita manter uma requisição HTTP aberta por minutos (timeout de proxy).
 */
let urlJob = null;

/**
 * POST /create-inventory-urls
 * Body: { networkId: string, urls: string[] }
 * Resposta: 202 { jobId } — o trabalho roda em background.
 *
 * Cadastra URLs no inventário do GAM (Inventory → URLs), uma por uma, com
 * Inventory type = Display e Brand type = Branded (default). Pula as que já
 * existem. Mesmo fluxo de browser/login do /create-display-channels.
 */
app.post('/create-inventory-urls', (req, res) => {
  const { networkId, urls } = req.body || {};

  if (!networkId || typeof networkId !== 'string') {
    return res.status(400).json({ error: 'networkId é obrigatório' });
  }
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls deve ser um array não vazio' });
  }
  if (urlJob && urlJob.status === 'running') {
    return res.status(409).json({
      error: 'Já existe um cadastro de URLs em andamento. Aguarde terminar.',
      jobId: urlJob.id,
    });
  }

  const jobId = String(Date.now());
  urlJob = { id: jobId, status: 'running', result: null, error: null, startedAt: Date.now() };

  res.status(202).json({ jobId });

  // Processamento em segundo plano
  (async () => {
    try {
      // 1. Obtém ou inicia o Chrome
      const conn = await getOrStartBrowser();
      const page = conn.page;
      if (conn.wasStarted) {
        console.log('[server] Chrome iniciado. Aguardando carregamento...');
        await new Promise(r => setTimeout(r, 3000));
      }

      // 2. Garante login no GAM (aguarda até 3 min se necessário)
      const loggedIn = await ensureGAMLogin(page, networkId);
      if (!loggedIn) {
        throw new Error('Timeout de login: ninguém fez login no GAM em 3 minutos. Tente novamente.');
      }

      // 3. Cadastra as URLs
      console.log(`[server] Cadastrando URLs — networkId=${networkId} total=${urls.length}`);
      const result = await createInventoryUrls(page, { networkId, urls });
      console.log(
        `[server] Concluído — cadastradas=${result.created.length} puladas=${result.skipped.length} falhas=${result.failed.length}`
      );
      urlJob = { ...urlJob, status: 'done', result, finishedAt: Date.now() };
    } catch (e) {
      console.error('[server] Erro ao cadastrar URLs:', e.message);
      urlJob = { ...urlJob, status: 'error', error: e.message, finishedAt: Date.now() };
    }
  })();
});

/**
 * GET /create-inventory-urls/:jobId
 * Resposta: { status: 'running'|'done'|'error', result?, error? }
 */
app.get('/create-inventory-urls/:jobId', (req, res) => {
  if (!urlJob || urlJob.id !== req.params.jobId) {
    return res.status(404).json({ error: 'Job não encontrado' });
  }
  return res.json({
    status: urlJob.status,
    result: urlJob.result,
    error: urlJob.error,
  });
});

app.listen(PORT, () => {
  console.log(`gam-puppeteer-service rodando na porta ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`\nFluxo ao clicar "Criar channels":`);
  console.log(`  1. Chrome abre automaticamente (se não estiver aberto)`);
  console.log(`  2. Navega para o GAM — faz login se necessário`);
  console.log(`  3. Executa a criação dos channels`);
});
