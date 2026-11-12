# Cadastro de URLs do inventário por RPC (card 132870)

`POST /create-inventory-urls` cadastra as URLs chamando o mesmo RPC que a tela do GAM usa, de dentro da aba
logada do robô (o Chrome é o único dono da sessão). Antes eram ~2 s por URL preenchendo o formulário.

## Como funciona (`lib/inventoryUrlsRpc.js`, módulo puro; `lib/createInventoryUrlsRpc.js` faz o `fetch` na aba)

1. XSRF: `GET /<rede>?hl=en`, padrão `xsrfToken: '...'`, uma vez por job.
2. Leitura (`PublisherQueryLanguageService`, `select_inventoryurl`): `WHERE Url LIKE '<domínio>%'`, um por domínio da lista, `ORDER BY Id ASC`, páginas de 500.
3. Ativa existente → "já existia". Inativa → falha "ativar à mão" (ou `reativada`, se `INVENTORY_URLS_REACTIVATE=true`).
4. O que falta vai em lote (`UrlService.createUrls`, blocos de 50). O lote é atômico: uma repetida recusa o bloco todo. Repetida apontada (`NOT_UNIQUE @ [i]`) vira "já existia" e o resto é reenviado uma vez; se repetir, uma URL por chamada, cada uma com o próprio motivo.
5. Releitura confirma. Criada que não aparece vira falha; ativada só vira `reativada` se a releitura mostrar `active=true`.

Regra de unicidade do GAM (etapa 0, 12/11/2026): grava sem protocolo e sem barra final, guarda maiúsculas mas compara sem elas, e `www.` é outra URL. É o `inventoryKey` (igual ao `inventoryUrlKey` da API).

## Classificação das falhas

| Situação | Classe | Caminho |
|---|---|---|
| 401/403, redirect, `fetch` com `TypeError`, HTML sem `xsrfToken` | sessão? | `ensureGAMLogin(page, rede, 5s)`. Deslogado: erro de login de hoje. Logado com 4xx no bootstrap, ou 401/403 que se repete depois de refazer o XSRF: erro do job "sem acesso à rede ou XSRF recusado", sem formulário. Logado, HTTP 200 sem `xsrfToken`: contrato |
| Tempo esgotado (30 s), 5xx, 429 no bootstrap ou na leitura | passageiro | uma nova tentativa; se falhar, formulário sem aviso |
| Tempo esgotado, 5xx, 429 na escrita | passageiro | sem nova tentativa; a releitura decide (aparece → criada; não → formulário) |
| Resposta que não vira JSON, sem `result`, com `error`, fora dos formatos `1279`/`2428`, leitura sem `id`/`url`/`active` | contrato | `GamContractError`: formulário só para as URLs sem resultado, com `contractWarning` ("avise o time de dev") |
| `2428` com código diferente de `NOT_UNIQUE` | erro da URL | uma por chamada; falha com código e texto do GAM |

Resposta do job: `created`, `skipped`, `failed`, `reactivated`, `method` (`rpc` | `puppeteer` | `rpc+puppeteer`) e, se houver, `contractWarning`.

## Variáveis (`docker-compose.yml`)

- `INVENTORY_URLS_MODE=rpc|puppeteer` (padrão `rpc`): `puppeteer` usa só o formulário.
- `INVENTORY_URLS_REACTIVATE=true|false` (padrão `false`): ativa URL inativa. Só ligar com a API (aceita `reativada` na retomada) e o Jarvis (`quiz_rewarded_cascata.py`) no ar.

Trocar variável dispensa build, mas `docker compose up -d` recria o container e **mata os jobs em andamento** (estado em memória): conferir `GET /health` sem job rodando antes.

## Se o GAM mudar a chamada

O robô cai sozinho para o formulário e o operador vê o aviso. Para recapturar: na tela Inventory → URLs, DevTools → Network, salvar uma URL de teste e copiar o `createUrls` (corpo e cabeçalhos, sem o cookie) e a leitura `select_inventoryurl`; ativar/desativar usa `UrlService.performUrlAction` (`"809":{"49":{}}` ativa, `"2865"` desativa). Ajustar os builders/decoders de `lib/inventoryUrlsRpc.js` e acrescentar a resposta nova em `test/fixtures/`. `npm test` roda sem Chrome nem GAM.

## Limite conhecido

Se a própria leitura falhar ou mudar de formato, o robô não sabe quais URLs estão inativas: tudo segue pelo formulário e uma inativa sai como "já existia" (comportamento anterior ao card). Esse job mostra o aviso ou o motivo no log.
