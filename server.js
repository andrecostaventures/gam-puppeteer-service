const express = require('express');
const {
  ensureHealthyBrowser,
  ensureGAMLogin,
  isBrowserConnected,
} = require('./lib/browser');
const { createDisplayChannels } = require('./lib/createDisplayChannels');
const { createInventoryUrls } = require('./lib/createInventoryUrls');
const { createInventoryUrlsRpc } = require('./lib/createInventoryUrlsRpc');
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
 * Jobs de criação de Display Channels.
 *
 * Assíncrono, mesmo padrão do cadastro de URLs: o POST devolve 202 { jobId }
 * na hora e o trabalho roda em background numa aba própria. O cliente acompanha
 * por polling em GET /create-display-channels/:jobId. Isso evita HTTP longo, que
 * era cortado pelo proxy reverso (Cloudflare/nginx) e gerava "fetch failed" no
 * backend mesmo quando a criação terminava com sucesso no GAM.
 */
const channelJobs = new Map(); // jobId -> { id, tag, networkId, status, total, done, created, skipped, result, error, startedAt, finishedAt }

/** Remove jobs finalizados há mais de 1h para o Map não crescer sem limite. */
function pruneOldChannelJobs() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, j] of channelJobs) {
    if (j.status !== 'running' && (j.finishedAt || 0) < cutoff) channelJobs.delete(id);
  }
}

/**
 * POST /create-display-channels
 * Body: { networkId: string, sources: string[], suffix?: string }
 * Resposta: 202 { jobId } — o trabalho roda em background, em aba própria.
 *           429 se não houver vaga no semáforo global.
 */
app.post('/create-display-channels', (req, res) => {
  const { networkId, sources, suffix } = req.body || {};

  if (!networkId || typeof networkId !== 'string') {
    return res.status(400).json({ error: 'networkId é obrigatório' });
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    return res.status(400).json({ error: 'sources deve ser um array não vazio' });
  }

  pruneOldChannelJobs();

  // Rejeição adiantada quando já está lotado (o semáforo ainda garante o limite
  // real, mas isso dá um erro claro sem criar job fantasma).
  if (runningCount() >= maxConcurrent()) {
    console.warn(
      `[server] ⛔ Sem vaga (${runningCount()}/${maxConcurrent()}) — job de channels recusado para net=${networkId}.`
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
    total: 0,
    done: 0,
    created: 0,
    skipped: 0,
    result: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  channelJobs.set(jobId, job);

  res.status(202).json({ jobId });

  console.log(
    `\n[server] ▶️  INÍCIO job channels ${tag} — suffix=${suffix || 'hs'} sources=${sources.join(', ')} | rodando agora: ${runningCount()}/${maxConcurrent()}`
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

      const loggedIn = await ensureGAMLogin(page, networkId);
      if (!loggedIn) {
        throw new Error('Timeout de login: o usuário não fez login no GAM em 3 minutos. Tente novamente.');
      }

      const result = await createDisplayChannels(page, {
        networkId,
        sources,
        suffix,
        onProgress: (p) => {
          job.total = p.total;
          job.done = p.done;
          job.created = p.created;
          job.skipped = p.skipped;
        },
      });

      job.result = {
        created: result.created,
        skipped: result.skipped,
        log: [
          `Criados (${result.created.length}): ${result.created.join(', ') || 'nenhum'}`,
          `Já existiam (${result.skipped.length}): ${result.skipped.join(', ') || 'nenhum'}`,
        ],
      };
      job.status = 'done';
      job.finishedAt = Date.now();
      const secs = Math.round((job.finishedAt - job.startedAt) / 1000);
      console.log(
        `[server] ✅ FIM job channels ${tag} — criados=${result.created.length} pulados=${result.skipped.length} em ${secs}s | ainda rodando: ${Math.max(0, runningCount() - 1)}/${maxConcurrent()}`
      );
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      job.finishedAt = Date.now();
      console.error(`[server] ❌ ERRO job channels ${tag} — ${e.message}`);
    } finally {
      if (page) {
        try { await page.close(); } catch { /* aba já fechada — ok */ }
      }
      if (slotHeld) release();
    }
  })();
});

/**
 * GET /create-display-channels/:jobId
 * Resposta: { status, networkId, progress: {done,total,created,skipped}, result?, error? }
 */
app.get('/create-display-channels/:jobId', (req, res) => {
  const job = channelJobs.get(req.params.jobId);
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
    },
    result: job.result,
    error: job.error,
  });
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
 * Cadastro de URLs: RPC primeiro (lib/createInventoryUrlsRpc.js); com contrato
 * alterado ou leitura passageira esgotada, só as URLs ainda sem resultado seguem
 * pelo formulário. INVENTORY_URLS_MODE=puppeteer usa só o formulário.
 * INVENTORY_URLS_REACTIVATE=true liga a ativação de URL inativa (D3).
 */
async function runUrlsJob(page, job, networkId, urls, tag) {
  const progress = (base) => (p) => {
    job.done = base.done + p.done;
    job.created = base.created + p.created;
    job.skipped = base.skipped + p.skipped;
    job.failed = base.failed + p.failed;
  };
  const zero = { done: 0, created: 0, skipped: 0, failed: 0 };

  if ((process.env.INVENTORY_URLS_MODE || 'rpc').toLowerCase() === 'puppeteer') {
    const form = await createInventoryUrls(page, { networkId, urls, tag, onProgress: progress(zero) });
    return { ...form, reactivated: [], method: 'puppeteer' };
  }

  const rpc = await createInventoryUrlsRpc(page, {
    networkId,
    urls,
    tag,
    onProgress: progress(zero),
    reactivate: process.env.INVENTORY_URLS_REACTIVATE === 'true',
  });
  const { pending, fallbackReason, contractDetail, contractWarning, log } = rpc;
  const result = {
    created: rpc.created,
    skipped: rpc.skipped,
    failed: rpc.failed,
    reactivated: rpc.reactivated,
    log: [...log],
    method: 'rpc',
  };
  const warnings = [];
  if (contractDetail) {
    warnings.push(
      pending.length
        ? `O GAM mudou a chamada de cadastro de URLs (${contractDetail}). O cadastro seguiu pelo formulário, mais lento. Avise o time de dev.`
        : `O GAM mudou a chamada de cadastro de URLs (${contractDetail}). Avise o time de dev.`
    );
  }
  if (contractWarning) warnings.push(contractWarning);

  if (pending.length) {
    console.log(`[${tag}] ${pending.length} URL(s) sem resultado no RPC (${fallbackReason || 'sem confirmação'}) — seguindo pelo formulário.`);
    const rpcResolved = result.created.length + result.skipped.length + result.failed.length + result.reactivated.length;
    const base = {
      done: job.done,
      created: result.created.length + result.reactivated.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
    };
    const form = await createInventoryUrls(page, { networkId, urls: pending, tag, onProgress: progress(base) });
    result.created.push(...form.created);
    result.skipped.push(...form.skipped);
    result.failed.push(...form.failed);
    result.log.push(...form.log);
    result.method = rpcResolved > 0 ? 'rpc+puppeteer' : 'puppeteer';
  }
  if (warnings.length) {
    result.contractWarning = warnings.join(' ');
    console.warn(`[${tag}] ⚠️ ${result.contractWarning}`);
  }
  return result;
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

      const result = await runUrlsJob(page, job, networkId, urls, tag);

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
