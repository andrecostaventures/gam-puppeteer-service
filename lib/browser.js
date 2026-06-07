const puppeteer = require('puppeteer');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PUPPETEER_PORT = process.env.CHROME_DEBUG_PORT || '9222';
const BROWSER_DATA_DIR = process.env.BROWSER_DATA_DIR ||
  path.join(__dirname, '../../gam-config-puppeteer/browser-data');

function getChromePath() {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
        ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Verifica se o Chrome está com a porta de debugging aberta.
 * Faz um HTTP GET em /json/version e retorna o websocket endpoint.
 */
async function getChromeDebugEndpoint() {
  const res = await fetch(`http://localhost:${PUPPETEER_PORT}/json/version`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.webSocketDebuggerUrl;
}

/**
 * Conecta ao Chrome via WebSocket debugging endpoint.
 */
async function connectToChrome() {
  const wsEndpoint = await getChromeDebugEndpoint();
  const browser = await puppeteer.connect({
    browserWSEndpoint: wsEndpoint,
    defaultViewport: null,
  });
  const pages = await browser.pages();
  const page = pages.find(p => !p.isClosed()) || (await browser.newPage());
  return { browser, page };
}

/**
 * Mata todos os processos Chrome em execução (Windows).
 * Necessário para garantir que o novo Chrome vai abrir com a porta de debugging.
 */
function killExistingChrome() {
  if (process.platform !== 'win32') return;
  try {
    execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' });
    console.log('[browser] Chrome anterior encerrado.');
  } catch {
    // Nenhum Chrome em execução — ok
  }
}

/**
 * Abre Chrome com porta de debugging via spawn.
 */
async function spawnChrome() {
  const chromePath = getChromePath();
  if (!chromePath) {
    throw new Error('Chrome não encontrado. Instale o Google Chrome e tente novamente.');
  }

  // Mata Chrome existente para garantir que os flags (--remote-debugging-port) sejam aplicados
  killExistingChrome();
  await new Promise(r => setTimeout(r, 1500));

  // Remove lock files que impedem o Chrome de iniciar (podem sobrar de sessão anterior)
  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  for (const f of lockFiles) {
    try { fs.unlinkSync(path.join(BROWSER_DATA_DIR, f)); } catch { /* não existe — ok */ }
  }

  console.log(`[browser] Abrindo Chrome com porta de debugging ${PUPPETEER_PORT}...`);

  const isDocker = process.platform !== 'win32';

  const args = [
    `--remote-debugging-port=${PUPPETEER_PORT}`,
    `--remote-debugging-address=0.0.0.0`,
    `--user-data-dir=${BROWSER_DATA_DIR}`,
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    '--disable-extensions',
    '--window-size=1920,1080',
    '--disable-notifications',
    '--lang=pt-BR',
    'about:blank',
  ];

  const env = { ...process.env };
  if (isDocker && !env.DISPLAY) {
    env.DISPLAY = ':99';
  }

  const chrome = spawn(chromePath, args, {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  // Loga erros do Chrome para facilitar diagnóstico
  chrome.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line) console.log(`[chrome stderr] ${line}`);
  });
  chrome.on('exit', (code) => {
    if (code !== null) console.log(`[chrome] processo encerrou com código ${code}`);
  });

  // Aguarda Chrome iniciar (até 20s)
  console.log('[browser] Aguardando Chrome iniciar...');
  for (let i = 1; i <= 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      await getChromeDebugEndpoint();
      console.log(`[browser] Porta de debugging pronta (${i}s).`);
      return;
    } catch (e) {
      if (i % 5 === 0) {
        console.log(`[browser] Ainda aguardando porta ${PUPPETEER_PORT}... (${i}s) — ${e.message}`);
      }
    }
  }
  throw new Error(`Porta de debugging ${PUPPETEER_PORT} não ficou disponível após 20s.`);
}

/**
 * Retorna uma página conectada ao Chrome.
 * Se Chrome não estiver rodando, inicia um novo.
 */
async function getOrStartBrowser() {
  // Tenta conectar ao Chrome já aberto com debugging
  try {
    const conn = await connectToChrome();
    console.log('[browser] Conectado ao Chrome já em execução.');
    return { ...conn, wasStarted: false };
  } catch {
    // Chrome não está rodando com debugging
  }

  // Inicia Chrome
  await spawnChrome();
  const conn = await connectToChrome();
  return { ...conn, wasStarted: true };
}

/**
 * Navega para o GAM e aguarda login se necessário (até 3 minutos).
 */
async function ensureGAMLogin(page, networkId, timeoutMs = 180_000) {
  const gamUrl = `https://admanager.google.com/${networkId}`;

  console.log('[browser] Navegando para o GAM...');
  try {
    await page.goto(gamUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch {
    // timeout de navegação — verifica URL mesmo assim
  }

  await new Promise(r => setTimeout(r, 2000));

  if (_isLoggedIn(page.url())) {
    console.log('[browser] Sessão GAM válida. Prosseguindo...');
    return true;
  }

  console.log('[browser] Não logado. Aguardando login manual (até 3 minutos)...');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const url = page.url();
    if (_isLoggedIn(url)) {
      console.log('[browser] Login detectado! Aguardando página carregar...');
      await new Promise(r => setTimeout(r, 2000));
      return true;
    }
  }

  return false;
}

function _isLoggedIn(url) {
  return (
    url.includes('admanager.google.com') &&
    !url.includes('accounts.google.com') &&
    !url.includes('/signin') &&
    !url.includes('/ServiceLogin')
  );
}

async function isBrowserConnected() {
  try {
    await getChromeDebugEndpoint();
    return true;
  } catch {
    return false;
  }
}

module.exports = { getOrStartBrowser, ensureGAMLogin, isBrowserConnected };
