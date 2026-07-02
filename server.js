const express = require('express');
const {
  ensureHealthyBrowser,
  ensureGAMLogin,
  isBrowserConnected,
} = require('./lib/browser');
const { createDisplayChannels } = require('./lib/createDisplayChannels');
const { createInventoryUrls } = require('./lib/createInventoryUrls');
const { acquire, release, runningCount, queuedCount, maxConcurrent } = require('./lib/concurrency');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3002;

app.get('/health', async (req, res) => {
  const connected = await isBrowserConnected();
  res.json({
    status: 'ok',
    browser: connected ? 'connected' : 'disconnected',
    concurrency: {
      running: runningCount(),
      queued: queuedCount(),
      max: maxConcurrent(),
    },
    message: connected
      ? 'Chrome conectado e pronto.'
      : 'Chrome não está rodando. Será iniciado automaticamente ao criar channels.',
  });
});

/**
 * POST /create-display-channels
 * Body: { networkId: string, sources: string[], suffix?: string }
 *
 * Síncrono (o backend espera a resposta). Adquire uma vaga no semáforo global
 * (compartilhado com o cadastro de URLs), roda em SUA PRÓPRIA ABA e garante um
 * Chrome saudável (reciclando se travado) quando é a única automação ativa.
 */
app.post('/create-display-channels', async (req, res) => {
  const { networkId, sources, suffix } = req.body || {};

  if (!networkId || typeof networkId !== 'string') {
    return res.status(400).json({ error: 'networkId é obrigatório' });
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    return res.status(400).json({ error: 'sources deve ser um array não vazio' });
  }

  // Espera uma vaga por até 2 min; se o sistema estiver cheio, responde 429.
  try {
    await acquire(120_000);
  } catch (e) {
    return res.status(429).json({
      error: e.message,
      running: runningCount(),
      maxConcurrent: maxConcurrent(),
    });
  }

  const soleJob = runningCount() === 1;
  let page = null;
  try {
    const browser = await ensureHealthyBrowser(soleJob);
    page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });

    const loggedIn = await ensureGAMLogin(page, networkId);
    if (!loggedIn) {
      return res.status(408).json({
        error: 'Timeout de login: o usuário não fez login no GAM em 3 minutos. Tente novamente.',
      });
    }

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
  } finally {
    if (page) {
      try { await page.close(); } catch { /* aba já fechada — ok */ }
    }
    release();
  }
});

/**
 * Jobs de cadastro de URLs (Inventory → URLs).
 *
 * Cada job roda em SUA PRÓPRIA ABA e disputa vaga no MESMO semáforo global das
 * demais automações (ver lib/concurrency.js). O droplet é pequeno, então o
 * limite de execuções simultâneas (channels + urls somados) é MAX_CONCURRENT_
 * AUTOMATIONS. A automação usa eventos sintéticos, então não depende da aba
 * estar em foco — por isso várias abas processam sem brigar por foco.
 *
 * O estado de cada job fica num Map; o cliente acompanha por polling em
 * GET /create-inventory-urls/:jobId (evita HTTP longo / timeout de proxy).
 */
const urlJobs = new Map(); // jobId -> { id, tag, networkId, status, total, done, created, skipped, failed, result, error, startedAt, finishedAt }

/** Remove jobs finalizados há mais de 1h para o Map não crescer sem limite. */
function pruneOldUrlJobs() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, j] of urlJobs) {
    if (j.status !== 'running' && (j.finishedAt || 0) < cutoff) urlJobs.delete(id);
  }
}

/**
 * POST /create-inventory-urls
 * Body: { networkId: string, urls: string[] }
 * Resposta: 202 { jobId } — o trabalho roda em background, em aba própria.
 *           429 se não houver vaga no semáforo global.
 *
 * Cadastra URLs no inventário do GAM (Inventory → URLs), uma por uma, com
 * Inventory type = Display e Brand type = Branded (default). Pula as que já existem.
 */
app.post('/create-inventory-urls', (req, res) => {
  const { networkId, urls } = req.body || {};

  if (!networkId || typeof networkId !== 'string') {
    return res.status(400).json({ error: 'networkId é obrigatório' });
  }
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls deve ser um array não vazio' });
  }

  pruneOldUrlJobs();

  // Rejeição adiantada quando já está lotado (o semáforo ainda garante o limite
  // real, mas isso dá um erro claro sem criar job fantasma).
  if (runningCount() >= maxConcurrent()) {
    console.warn(
      `[server] ⛔ Sem vaga (${runningCount()}/${maxConcurrent()}) — job de URLs recusado para net=${networkId}.`
    );
    return res.status(429).json({
      error: `Limite de ${maxConcurrent()} execuções simultâneas atingido. Aguarde alguma terminar e tente de novo.`,
      running: runningCount(),
      maxConcurrent: maxConcurrent(),
    });
  }

  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const tag = `${networkId}#${jobId.slice(-5)}`;
  const job = {
    id: jobId,
    tag,
    networkId,
    status: 'running',
    total: urls.length,
    done: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    result: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  urlJobs.set(jobId, job);

  res.status(202).json({ jobId });

  console.log(
    `\n[server] ▶️  INÍCIO job ${tag} — ${urls.length} URLs | rodando agora: ${runningCount()}/${maxConcurrent()}`
  );

  // Processamento em segundo plano, em ABA PRÓPRIA.
  (async () => {
    let page = null;
    let slotHeld = false;
    try {
      await acquire(); // espera vaga no semáforo global
      slotHeld = true;

      const soleJob = runningCount() === 1;
      const browser = await ensureHealthyBrowser(soleJob);
      page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 900 });

      // Login no GAM (sessão compartilhada — normalmente já logado, retorna na hora)
      const loggedIn = await ensureGAMLogin(page, networkId);
      if (!loggedIn) {
        throw new Error('Timeout de login: ninguém fez login no GAM em 3 minutos. Tente novamente.');
      }

      const result = await createInventoryUrls(page, {
        networkId,
        urls,
        tag,
        onProgress: (p) => {
          job.done = p.done;
          job.created = p.created;
          job.skipped = p.skipped;
          job.failed = p.failed;
        },
      });

      job.result = result;
      job.status = 'done';
      job.finishedAt = Date.now();
      const secs = Math.round((job.finishedAt - job.startedAt) / 1000);
      console.log(
        `[server] ✅ FIM job ${tag} — criadas=${result.created.length} puladas=${result.skipped.length} falhas=${result.failed.length} em ${secs}s | ainda rodando: ${Math.max(0, runningCount() - 1)}/${maxConcurrent()}`
      );
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      job.finishedAt = Date.now();
      console.error(`[server] ❌ ERRO job ${tag} — ${e.message}`);
    } finally {
      if (page) {
        try { await page.close(); } catch { /* aba já fechada — ok */ }
      }
      if (slotHeld) release();
    }
  })();
});

/**
 * GET /create-inventory-urls/:jobId
 * Resposta: { status, networkId, progress: {done,total,created,skipped,failed}, result?, error? }
 */
app.get('/create-inventory-urls/:jobId', (req, res) => {
  const job = urlJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job não encontrado' });
  }
  return res.json({
    status: job.status,
    networkId: job.networkId,
    progress: {
      done: job.done,
      total: job.total,
      created: job.created,
      skipped: job.skipped,
      failed: job.failed,
    },
    result: job.result,
    error: job.error,
  });
});

app.listen(PORT, () => {
  console.log(`gam-puppeteer-service rodando na porta ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Concorrência: até ${maxConcurrent()} automações simultâneas (channels + URLs somados, cada uma em sua aba).`);
});
