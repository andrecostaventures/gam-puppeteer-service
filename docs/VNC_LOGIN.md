# Login no GAM via VNC (gam-puppeteer-service)

O Chrome do serviço roda **headless** dentro do container, num display virtual
(`Xvfb :99`). Para fazer o login do Google manualmente (a primeira vez ou quando a
sessão expira), usamos o **x11vnc** — que espelha o display `:99` — e acessamos pelo
**TigerVNC Viewer** através de um **túnel SSH**.

> A sessão fica salva no volume `browser-data` (`/opt/gam-puppeteer-service/browser-data`),
> então só é necessário refazer o login quando a sessão do Google expirar.

Dados do servidor: `root@143.198.183.17` · container `gam-puppeteer-service` ·
display `:99` · porta VNC `5900` (exposta só em `127.0.0.1`).

---

## Pré-requisito (uma vez): aplicar o setup de VNC

O `x11vnc` já está embutido no `Dockerfile` e a porta `5900` publicada no
`docker-compose.yml` (apenas em `127.0.0.1`). Se o container do servidor ainda foi
buildado **antes** dessa mudança, rebuilde:

```bash
ssh root@143.198.183.17
cd /opt/gam-puppeteer-service/src
docker compose -f gam-puppeteer-service/docker-compose.yml up -d --build
```

Confirme que o x11vnc subiu:
```bash
docker exec gam-puppeteer-service sh -c "ps aux | grep -i x11vnc | grep -v grep"
```

---

## Passo a passo do login

### 1. Abrir o túnel SSH (no seu PC, PowerShell)
Encaminha a porta VNC do servidor para a sua máquina:
```powershell
ssh -L 5900:localhost:5900 root@143.198.183.17
```
Deixe essa janela aberta durante todo o processo.

### 2. Conectar o TigerVNC Viewer (no seu PC)
Abra o **TigerVNC Viewer** e conecte em:
```
localhost:5900
```
(Sem senha — o acesso é protegido pelo túnel SSH; o x11vnc roda com `-localhost`.)
Você verá a tela do Chrome no display `:99`.

### 3. Disparar a ação no dashboard
No dashboard, clique na ação de GAM que usa o Puppeteer (ex.: "Criar channels").
Isso chama o `POST /create-display-channels`, que:
1. abre/conecta o Chrome,
2. navega até o GAM,
3. **aguarda o login manual por até 3 minutos** (`ensureGAMLogin`).

### 4. Fazer o login do Google (dentro dos 3 minutos)
Na janela do TigerVNC, faça o login normalmente na conta Google do GAM.
Assim que a URL virar `admanager.google.com/...` (sai de `accounts.google.com`),
o serviço detecta o login e segue a execução automaticamente.

### 5. Encerrar
Pode fechar o TigerVNC Viewer e o túnel SSH. A sessão fica salva no `browser-data`.

---

## Notas de segurança
- A porta `5900` é publicada **somente em `127.0.0.1`** (no host e no container via
  `-localhost`), nunca exposta na internet. O único acesso é pelo túnel SSH.
- Por isso o x11vnc roda com `-nopw` (sem senha): a barreira de segurança é o SSH.
- Se preferir senha no VNC, troque `-nopw` por `-rfbauth /caminho/senha` no
  `Dockerfile` e gere o arquivo com `x11vnc -storepasswd`.

## Troubleshooting
- **TigerVNC não conecta**: confirme o túnel SSH ativo e o x11vnc rodando (comando
  do pré-requisito). Veja logs: `docker logs gam-puppeteer-service`.
- **Tela preta**: o Chrome pode não ter aberto ainda — dispare a ação no dashboard
  (passo 3); o Chrome só abre sob demanda.
- **"x11vnc: command not found"**: o container foi buildado antes do setup — refaça
  o rebuild do pré-requisito.
