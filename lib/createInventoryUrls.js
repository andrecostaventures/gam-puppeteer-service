/**
 * Cadastro de URLs no inventário do GAM (Inventory → URLs) via Puppeteer.
 * Portado da extensão high-stakes-toolkit-v2 (scripts/check_urls.js) para o
 * padrão de worker do gam-puppeteer-service: função (page, { networkId, urls })
 * que retorna { created, skipped, failed, log }.
 *
 * Inventory type fixo em "Display" e Brand type no default (Branded), igual à
 * extensão. As esperas usam waitForSelector/waitForFunction em vez de delays
 * fixos para ficar mais rápido.
 */

const Action = require('../../gam-config-puppeteer/models/Accessibility');
const { sleep } = require('../../gam-config-puppeteer/models/Util');

const T = {
	newUrl: ['New URL', 'Novo URL'],
	save: ['Save', 'Salvar'],
};

function getUrlsListUrl(networkId) {
	return `https://admanager.google.com/${networkId}#inventory/url/list`;
}

/** Tira protocolo e barra final — mesma normalização da extensão. */
function normalizeUrl(url) {
	return String(url || '')
		.trim()
		.replace(/^https?:\/\//i, '')
		.replace(/\/+$/, '');
}

async function navigateToUrlsList(page, networkId) {
	await page.goto(getUrlsListUrl(networkId), {
		waitUntil: 'domcontentloaded',
		timeout: 60000,
	});
	const ready =
		(await Action.waitForText(page, 'New URL', 30000)) ||
		(await Action.waitForText(page, 'Novo URL', 5000));
	if (!ready) {
		throw new Error('Página de URLs não carregou (botão "New URL" não apareceu).');
	}
	await sleep(500);
}

/**
 * Lê as URLs já presentes na lista renderizada (best-effort — a lista é
 * virtualizada, então pega só o que está na tela). Serve de dedup rápido.
 */
async function readExistingUrls(page) {
	const list = await page.evaluate(() => {
		const norm = (u) =>
			String(u || '')
				.trim()
				.replace(/^https?:\/\//i, '')
				.replace(/\/+$/, '')
				.toLowerCase();
		const out = new Set();
		const nodes = document.querySelectorAll(
			'table td, [role="gridcell"], [role="cell"], [role="row"] a, a[href*="url"]'
		);
		nodes.forEach((el) => {
			const t = (el.textContent || '').trim();
			if (t && t.includes('.')) out.add(norm(t));
		});
		return Array.from(out);
	});
	return new Set(list);
}

/** Clica no elemento (topmost por z-index) cujo texto bate exatamente. */
async function clickElementWithText(page, texts) {
	return page.evaluate((wanted) => {
		const els = Array.from(document.querySelectorAll('*')).filter((el) =>
			wanted.includes((el.textContent || '').trim())
		);
		const clickables = els.filter(
			(el) => el.getAttribute('disabled') === null && !el.classList.contains('is-disabled')
		);
		if (!clickables.length) return false;
		const target = clickables.reduce((a, b) => {
			const za = parseInt(getComputedStyle(a).zIndex) || 0;
			const zb = parseInt(getComputedStyle(b).zIndex) || 0;
			return zb > za ? b : a;
		}, clickables[0]);
		target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
		['mousedown', 'mouseup', 'click'].forEach((type) =>
			target.dispatchEvent(new MouseEvent(type, { view: window, bubbles: true, cancelable: true }))
		);
		return true;
	}, texts);
}

async function fillUrlInput(page, url) {
	return page.evaluate((value) => {
		const inp = document.querySelector('material-input[ngcontrol="url"] input[type="url"]');
		if (!inp) return false;
		inp.focus();
		inp.value = '';
		inp.value = value;
		inp.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	}, url);
}

async function openProductDropdown(page) {
	return page.evaluate(() => {
		const dd = document.querySelector('material-dropdown-select[debugid="productSelect"]');
		if (!dd) return false;
		const btn = dd.querySelector('dropdown-button button, dropdown-button div.button, dropdown-button div');
		if (!btn) return false;
		btn.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
		['mousedown', 'mouseup', 'click'].forEach((type) =>
			btn.dispatchEvent(new MouseEvent(type, { view: window, bubbles: true, cancelable: true }))
		);
		return true;
	});
}

async function selectDisplayOption(page) {
	return page.evaluate(() => {
		const opts = Array.from(document.querySelectorAll('material-select-dropdown-item')).filter((el) => {
			const lbl = el.querySelector('span.label');
			return lbl && lbl.textContent.trim().toLowerCase() === 'display';
		});
		if (!opts.length) return false;
		const target = opts.reduce((a, b) => {
			const za = parseInt(getComputedStyle(a).zIndex) || 0;
			const zb = parseInt(getComputedStyle(b).zIndex) || 0;
			return zb > za ? b : a;
		}, opts[0]);
		target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
		['mousedown', 'mouseup', 'click'].forEach((type) =>
			target.dispatchEvent(new MouseEvent(type, { view: window, bubbles: true, cancelable: true }))
		);
		return true;
	});
}

/**
 * Espera a confirmação do salvamento: toast ("URL saved"/"URL foi ...") OU o
 * fechamento do formulário (o campo de URL some da tela). O fechamento do
 * formulário é o sinal mais confiável de que o save foi efetivado.
 */
async function waitForSaveConfirmation(page, timeout = 15000) {
	try {
		await page.waitForFunction(
			() => {
				const formOpen = !!document.querySelector(
					'material-input[ngcontrol="url"] input[type="url"]'
				);
				if (!formOpen) return true;
				const t = ((document.body && document.body.innerText) || '').toLowerCase();
				return t.includes('url saved') || t.includes('url foi');
			},
			{ timeout }
		);
		return true;
	} catch {
		return false;
	}
}

/** Detecta mensagem de URL duplicada/já existente. */
async function pageIndicatesDuplicate(page) {
	return page.evaluate(() => {
		const t = ((document.body && document.body.innerText) || '').toLowerCase();
		return [
			'already exists',
			'already in use',
			'must be unique',
			'duplicate',
			'já existe',
			'já está em uso',
		].some((h) => t.includes(h));
	});
}

async function addOneUrl(page, url) {
	// 1) New URL
	if (!(await clickElementWithText(page, T.newUrl))) {
		throw new Error('Botão "New URL" não encontrado');
	}
	try {
		await page.waitForSelector('material-input[ngcontrol="url"] input[type="url"]', {
			timeout: 10000,
			visible: true,
		});
	} catch {
		throw new Error('Campo de URL não apareceu');
	}

	// 2) Preencher URL
	if (!(await fillUrlInput(page, url))) {
		throw new Error('Campo de URL não encontrado');
	}
	await sleep(150);

	// 3) Abrir dropdown de produto
	if (!(await openProductDropdown(page))) {
		throw new Error('Dropdown de produto não encontrado');
	}
	try {
		await page.waitForSelector('material-select-dropdown-item', { timeout: 8000, visible: true });
	} catch {
		throw new Error('Opções do dropdown de produto não apareceram');
	}

	// 4) Selecionar "Display"
	let selected = await selectDisplayOption(page);
	if (!selected) {
		await sleep(400);
		selected = await selectDisplayOption(page);
	}
	if (!selected) {
		throw new Error('Opção "Display" não encontrada');
	}
	await sleep(200);

	// 5) Salvar
	let clickedSave = false;
	for (let i = 0; i < 10; i++) {
		clickedSave = await clickElementWithText(page, T.save);
		if (clickedSave) break;
		await sleep(300);
	}
	if (!clickedSave) {
		throw new Error('Botão "Salvar" não encontrado');
	}

	// 6) Confirmar
	if (await waitForSaveConfirmation(page)) {
		return 'created';
	}
	if (await pageIndicatesDuplicate(page)) {
		return 'duplicate';
	}
	throw new Error('Confirmação de salvamento não apareceu');
}

/**
 * Função principal exportada.
 * @param {object} page - Página Puppeteer já conectada ao Chrome (logada no GAM)
 * @param {object} options
 * @param {string} options.networkId - Ex.: '23314778729'
 * @param {string[]} options.urls - Lista de URLs a cadastrar (com ou sem https/barra)
 * @returns {{ created: string[], skipped: string[], failed: {url: string, error: string}[], log: string[] }}
 */
async function createInventoryUrls(page, { networkId, urls }) {
	const created = [];
	const skipped = [];
	const failed = [];
	const log = [];

	// Normaliza e remove duplicadas da própria lista de entrada
	const normalized = [];
	const seen = new Set();
	for (const raw of urls || []) {
		const u = normalizeUrl(raw);
		if (!u || seen.has(u.toLowerCase())) continue;
		seen.add(u.toLowerCase());
		normalized.push(u);
	}

	log.push(`Total de URLs (após normalizar/dedupe): ${normalized.length}`);
	console.log(`[create-inventory-urls] networkId=${networkId} total=${normalized.length}`);

	await navigateToUrlsList(page, networkId);

	// Dedup best-effort contra o que já está na tela
	const existing = await readExistingUrls(page);

	for (const url of normalized) {
		if (existing.has(url.toLowerCase())) {
			skipped.push(url);
			console.log(`⏭️  Já existe (pulando): ${url}`);
			continue;
		}
		try {
			const result = await addOneUrl(page, url);
			if (result === 'duplicate') {
				skipped.push(url);
				console.log(`⏭️  Já existe (detectado ao salvar): ${url}`);
			} else {
				created.push(url);
				existing.add(url.toLowerCase());
				console.log(`✔ Cadastrada: ${url}`);
			}
			await sleep(800);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			failed.push({ url, error: msg });
			console.log(`✖ Falhou: ${url} → ${msg}`);
			// Tenta voltar para a lista para a próxima URL não herdar um estado quebrado
			try {
				await navigateToUrlsList(page, networkId);
			} catch {
				/* segue mesmo assim */
			}
		}
	}

	log.push(`Cadastradas (${created.length}): ${created.join(', ') || 'nenhuma'}`);
	log.push(`Já existiam (${skipped.length}): ${skipped.join(', ') || 'nenhuma'}`);
	log.push(
		`Falhas (${failed.length}): ${failed.map((f) => `${f.url} (${f.error})`).join('; ') || 'nenhuma'}`
	);

	return { created, skipped, failed, log };
}

module.exports = { createInventoryUrls };
