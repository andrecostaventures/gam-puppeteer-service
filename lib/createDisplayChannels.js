/**
 * Lógica de criação de Display Channels no GAM via Puppeteer.
 * Adaptado de gam-config-puppeteer/createDisplayChannels.js para receber
 * networkId e sources como parâmetros (em vez de constants.js fixo).
 */

// Reutiliza os models do projeto original (mesmo servidor)
const Action = require('../../gam-config-puppeteer/models/Accessibility');
const { sleep, robustElementClick } = require('../../gam-config-puppeteer/models/Util');

function getChannelsListUrl(networkId) {
  return `https://admanager.google.com/${networkId}#inventory/channel/list/product=content`;
}

function getChannelName(source) {
  if (source === 'all') return 'utm_source=all';
  return `utm_source=${source}`;
}

async function navigateToChannelsList(page, networkId) {
  await page.goto(getChannelsListUrl(networkId), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await Action.waitForText(page, 'New display channel', 30000);
  await sleep(400);
}

async function clearListFilters(page) {
  await page.evaluate(() => {
    const selectors = ['.delete-icon-container','[aria-label*="Remove filter"]','[aria-label*="Remove"]','button[aria-label*="Clear filter"]'];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((btn) => { try { btn.click(); } catch (_) {} });
    }
  });
  await sleep(800);
}

class ChannelAlreadyExistsError extends Error {
  constructor(channelName) {
    super(`Channel já existe: ${channelName}`);
    this.name = 'ChannelAlreadyExistsError';
    this.channelName = channelName;
  }
}

async function channelExistsOnList(page, networkId, channelName) {
  await navigateToChannelsList(page, networkId);
  await clearListFilters(page);
  const found = await page.evaluate((name) => {
    const target = (name || '').replace(/\s+/g, ' ').trim();
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const nodes = Array.from(document.querySelectorAll('table a, [role="grid"] a, [role="row"] a, table td, [role="gridcell"], [role="cell"], a[href*="channel"]')).filter(isVisible);
    for (const el of nodes) {
      if (norm(el.textContent) === target) return true;
    }
    return false;
  }, channelName);
  return found;
}

async function pageIndicatesDuplicateChannel(page) {
  const body = await page.evaluate(() => (document.body?.innerText || '').toLowerCase());
  return ['already in use','already exists','must be unique','duplicate','name is taken','já está em uso','já existe'].some((h) => body.includes(h));
}

async function isChannelEditorOpen(page) {
  return Action.waitForText(page, 'All custom key-values', 1200);
}

async function closeChannelEditorIfOpen(page, networkId) {
  const onForm = await isChannelEditorOpen(page);
  if (onForm) {
    try { await page.keyboard.press('Escape'); await sleep(400); } catch (_) {}
    let cancel = await Action.findNodeByRoleAndName(page, 'button', 'Cancel');
    if (!cancel) cancel = await Action.findNodeByRoleAndNameContains(page, 'button', 'Cancel');
    if (cancel) {
      const handle = await cancel.elementHandle();
      if (handle) { await handle.click(); await sleep(1200); }
    }
  }
  await navigateToChannelsList(page, networkId);
}

async function clickAxNode(axNode, label) {
  if (!axNode) throw new Error(`${label} não encontrado.`);
  const handle = await axNode.elementHandle();
  if (!handle) throw new Error(`${label}: não foi possível obter elemento clicável.`);
  await handle.click();
  return handle;
}

async function dismissOpenOverlays(page) {
  try { await page.keyboard.press('Escape'); await sleep(200); await page.keyboard.press('Escape'); } catch (_) {}
  await page.evaluate(() => {
    const backdrop = document.querySelector('.cdk-overlay-backdrop, .mat-overlay-backdrop, [class*="overlay-backdrop"]');
    if (backdrop && typeof backdrop.click === 'function') backdrop.click();
  });
  await sleep(350);
}

async function clickAndInCustomTargeting(page) {
  await dismissOpenOverlays(page);
  const clickedDom = await page.evaluate(() => {
    const normLower = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const isVisible = (el) => { if (!el || !(el instanceof Element)) return false; const style = window.getComputedStyle(el); const rect = el.getBoundingClientRect(); return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 2 && rect.height > 2; };
    const isAnd = (raw) => { const t = normLower(raw); return t === 'and' || t === 'e'; };
    const regions = Array.from(document.querySelectorAll('section, div, fieldset, [role="group"], [role="region"], form')).filter(isVisible);
    let root = null;
    for (const r of regions) { const txt = normLower(r.textContent || ''); if (txt.includes('custom targeting') || txt.includes('segmentação personalizada') || txt.includes('targeting personalizada') || txt.includes('segmentação por')) { root = r; break; } }
    if (!root) root = document.body;
    const clickables = Array.from(root.querySelectorAll('button, [role="button"], a, span, [role="link"]')).filter(isVisible);
    for (const el of clickables) { const label = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim(); if (!isAnd(label)) continue; el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); el.click(); return true; }
    return false;
  });
  if (clickedDom) { await sleep(600); return; }
  for (const name of ['And', 'E', 'AND']) {
    let andButton = await Action.findNodeByRoleAndName(page, 'button', name);
    if (!andButton) andButton = await Action.findNodeByRoleAndName(page, 'link', name);
    if (andButton) { const handle = await andButton.elementHandle(); if (handle) { await robustElementClick(handle); await sleep(600); return; } }
  }
  throw new Error('Botão "And" / "E" não encontrado na seção Custom targeting.');
}

async function findHsFloorTypeTreeItem(page) {
  let node = await Action.findNodeByRoleAndName(page, 'treeitem', 'hs_floor_type (hs_floor_type)');
  if (!node) node = await Action.findNodeByRoleAndNameContains(page, 'treeitem', 'hs_floor_type');
  return node;
}

async function addHsFloorTypeCriterion(page) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await dismissOpenOverlays(page);
    await sleep(attempt === 1 ? 700 : 1100);
    let hsNode = await findHsFloorTypeTreeItem(page);
    if (hsNode) { await clickAxNode(hsNode, 'Opção "hs_floor_type"'); return; }
    if (await Action.waitForText(page, 'Select parameter', 3000)) {
      const btn = await Action.findNodeByRoleAndName(page, 'button', 'Select parameter');
      if (btn) { const h = await btn.elementHandle(); if (h) { await h.click(); await sleep(900); } }
    }
    hsNode = await findHsFloorTypeTreeItem(page);
    if (hsNode) { await clickAxNode(hsNode, 'Opção "hs_floor_type"'); return; }
    if (attempt < 5) { console.log(`  ↻ Tentativa ${attempt + 1}/5: clicando And novamente...`); await clickAndInCustomTargeting(page); }
  }
  throw new Error('Não foi possível adicionar o critério hs_floor_type após And.');
}

async function assertSaveSucceeded(page, networkId, channelName) {
  const saved = await Action.waitForText(page, 'Successfully ', 5000);
  if (saved) return;
  if (await pageIndicatesDuplicateChannel(page)) throw new ChannelAlreadyExistsError(channelName);
  if (await channelExistsOnList(page, networkId, channelName)) throw new ChannelAlreadyExistsError(channelName);
  throw new Error('Erro ao salvar display channel.');
}

async function processDisplayChannel(page, networkId, source, createFn) {
  const channelName = getChannelName(source);
  if (await channelExistsOnList(page, networkId, channelName)) {
    console.log(`⏭️  Channel já existe (pulando): ${channelName}`);
    return 'skipped';
  }
  console.log(`Criando display channel: ${channelName}...`);
  try {
    await navigateToChannelsList(page, networkId);
    await createFn(page, source);
    return 'created';
  } catch (err) {
    const isDuplicate = err instanceof ChannelAlreadyExistsError || err.name === 'ChannelAlreadyExistsError' || (await pageIndicatesDuplicateChannel(page));
    if (isDuplicate) { await closeChannelEditorIfOpen(page, networkId); console.log(`⏭️  Channel já existe (detectado ao salvar): ${channelName}`); return 'skipped'; }
    throw err;
  }
}

async function createDisplayChannelNormal(page, networkId, source) {
  await navigateToChannelsList(page, networkId);
  let btn = await Action.findNodeByName(page, 'New display channel');
  if (!btn) throw new Error('Botão "New display channel" não encontrado.');
  await clickAxNode(btn, 'Botão "New display channel"');
  await sleep(600);
  await Action.waitForText(page, 'All custom key-values');
  let nameInput = await Action.findNodeByRoleAndName(page, 'textbox', 'Name');
  if (!nameInput) throw new Error('Input "Name" não encontrado.');
  nameInput = await nameInput.elementHandle();
  await nameInput.click(); await nameInput.focus(); await nameInput.click({ clickCount: 3 }); await sleep(100);
  await nameInput.type(`utm_source=${source}`); await sleep(100);
  let ctLine = await Action.findNodeByRoleAndNameAndDescription(page, 'button', 'Custom targeting', 'done All custom key-values');
  if (!ctLine) throw new Error('Linha "Custom targeting" não encontrada.');
  ctLine = await ctLine.elementHandle(); await ctLine.click();
  if (!await Action.waitForText(page, 'Select parameter')) throw new Error('Texto "Select parameter" não encontrado.');
  await sleep(1500);
  let ctSelect = await Action.findNodeByRoleAndName(page, 'button', 'Select parameter');
  if (!ctSelect) throw new Error('Input "Select Targeting" não encontrado.');
  ctSelect = await ctSelect.elementHandle(); await ctSelect.click();
  await Action.waitForText(page, '(utm_source)', 10000);
  let utmOption = await Action.findNodeByRoleAndName(page, 'treeitem', 'utm_source (utm_source)');
  if (!utmOption) utmOption = await Action.findNodeByRoleAndNameContains(page, 'treeitem', 'utm_source');
  await clickAxNode(utmOption, 'Opção "utm_source"'); await sleep(250);
  let searchInput = await Action.findNodeByRoleAndName(page, 'textbox', 'Search or paste a comma-separated list');
  if (!searchInput) searchInput = await Action.findNodeByRoleAndNameContains(page, 'textbox', 'Search or paste');
  if (!searchInput) searchInput = await Action.findNodeByRoleAndNameContains(page, 'textbox', 'Search');
  if (!searchInput) throw new Error('Campo de busca não encontrado.');
  searchInput = await searchInput.elementHandle();
  await searchInput.click(); await searchInput.focus(); await searchInput.click({ clickCount: 3 }); await sleep(200);
  const sourceValue = source.split('|')[0];
  await searchInput.type(sourceValue); await sleep(500);
  await Action.waitForText(page, sourceValue, 10000);
  let sourceOption = await Action.findNodeByRoleAndNameContains(page, 'option', sourceValue);
  if (!sourceOption) sourceOption = await Action.findNodeByRoleAndNameContains(page, 'option', `(${sourceValue})`);
  if (!sourceOption) sourceOption = await Action.findNodeByRoleAndNameContains(page, 'listitem', sourceValue);
  if (!sourceOption) throw new Error(`Opção de source "${sourceValue}" não encontrada.`);
  await clickAxNode(sourceOption, `Opção de source "${sourceValue}"`); await sleep(400);
  await dismissOpenOverlays(page);
  await Action.waitForText(page, sourceValue, 10000); await sleep(500);
  if (source.includes('general')) {
    await clickAndInCustomTargeting(page);
    await addHsFloorTypeCriterion(page); await sleep(250);
    let floorInput = await Action.findNodeByRoleAndName(page, 'textbox', 'Search or paste a comma-separated list');
    if (!floorInput) floorInput = await Action.findNodeByRoleAndNameContains(page, 'textbox', 'Search or paste');
    if (!floorInput) floorInput = await Action.findNodeByRoleAndNameContains(page, 'textbox', 'Search');
    if (!floorInput) throw new Error('Campo de busca floor type não encontrado.');
    floorInput = await floorInput.elementHandle();
    await floorInput.click(); await floorInput.focus(); await floorInput.click({ clickCount: 3 }); await sleep(200);
    await floorInput.type('general'); await sleep(500);
    await Action.waitForText(page, 'general', 10000);
    let floorOption = await Action.findNodeByRoleAndNameContains(page, 'option', 'general');
    if (!floorOption) floorOption = await Action.findNodeByRoleAndNameContains(page, 'option', '(general)');
    if (!floorOption) floorOption = await Action.findNodeByRoleAndNameContains(page, 'listitem', 'general');
    if (!floorOption) throw new Error('Opção de floor type "general" não encontrada.');
    floorOption = await floorOption.elementHandle(); await floorOption.click(); await sleep(100);
  }
  let saveButton = await Action.findNodeByRoleAndName(page, 'button', 'Save');
  if (!saveButton) throw new Error('Botão "Save" não encontrado.');
  saveButton = await saveButton.elementHandle(); saveButton.click();
  await assertSaveSucceeded(page, networkId, getChannelName(source));
  console.log(`Display channel "${getChannelName(source)}" criado com sucesso!`);
  await sleep(2500);
}

function buildChannelJobs(sources) {
  const jobs = [];
  for (const source of sources) {
    if (source === 'all') {
      jobs.push({ source: 'all' });
      continue;
    }
    jobs.push({ source });
    jobs.push({ source: `${source}|general` });
  }
  return jobs;
}

/**
 * Função principal exportada.
 * @param {object} page - Página Puppeteer já conectada ao Chrome
 * @param {object} options
 * @param {string} options.networkId - Ex.: '23314778729'
 * @param {string[]} options.sources - Ex.: ['br-google-es', 'google-es', 'email-es']
 * @returns {{ created: string[], skipped: string[] }}
 */
async function createDisplayChannels(page, { networkId, sources }) {
  const created = [];
  const skipped = [];
  const jobs = buildChannelJobs(sources);
  console.log(`Total de channels no fluxo: ${jobs.length}`);

  await navigateToChannelsList(page, networkId);

  for (const job of jobs) {
    const channelName = getChannelName(job.source);
    const result = await processDisplayChannel(
      page,
      networkId,
      job.source,
      (p, src) => createDisplayChannelNormal(p, networkId, src)
    );
    if (result === 'created') created.push(channelName);
    else skipped.push(channelName);
  }

  return { created, skipped };
}

module.exports = { createDisplayChannels };
