/**
 * Semáforo global de concorrência para as automações Puppeteer.
 *
 * TODAS as automações (criação de channels + cadastro de URLs) compartilham um
 * ÚNICO Chrome. O droplet é pequeno (2 vCPU / ~3.8GB, sem swap) e a UI do GAM
 * (Angular) é pesada em CPU/memória, então rodar automações demais ao mesmo
 * tempo satura o Chrome e trava tudo (Runtime.callFunctionOn timed out).
 *
 * Este semáforo limita quantas rodam simultaneamente, independente do tipo.
 * Ajustável via env MAX_CONCURRENT_AUTOMATIONS (default 2 = nº de vCPUs).
 */

const MAX_CONCURRENT = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_AUTOMATIONS || '2', 10)
);

let active = 0;
const waiters = []; // fila de { resolve, timer }

function runningCount() {
  return active;
}

function queuedCount() {
  return waiters.length;
}

function maxConcurrent() {
  return MAX_CONCURRENT;
}

/**
 * Adquire um slot de execução. Resolve imediatamente se houver vaga; senão
 * entra na fila. Se timeoutMs > 0 e a vaga não sair a tempo, rejeita (usado
 * pelo endpoint síncrono de channels para não segurar a conexão HTTP à toa).
 */
function acquire(timeoutMs = 0) {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, timer: null };
    if (timeoutMs > 0) {
      waiter.timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(
          new Error(
            `Sistema ocupado: ${active} execução(ões) em andamento (máx ${MAX_CONCURRENT}). ` +
              `Não houve vaga em ${Math.round(timeoutMs / 1000)}s. Tente de novo em instantes.`
          )
        );
      }, timeoutMs);
    }
    waiters.push(waiter);
  });
}

/** Libera um slot. Se houver alguém na fila, passa a vaga adiante. */
function release() {
  const waiter = waiters.shift();
  if (waiter) {
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve(); // a vaga é transferida — active não muda
  } else {
    active = Math.max(0, active - 1);
  }
}

module.exports = { acquire, release, runningCount, queuedCount, maxConcurrent };
