FROM ubuntu:22.04

# Evita prompts interativos durante apt
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_VERSION=22

# Instala Node.js, Chrome, Xvfb e dependências
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    ca-certificates \
    wget \
    xvfb \
    x11vnc \
    # Dependências do Chrome
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    fonts-liberation \
    --no-install-recommends

# Instala Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs --no-install-recommends

# Instala Google Chrome Stable
RUN wget -q -O /tmp/chrome.deb \
    https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
    apt-get install -y /tmp/chrome.deb --no-install-recommends && \
    rm /tmp/chrome.deb

# Limpa cache
RUN apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia os models do gam-config-puppeteer (referenciados por createDisplayChannels.js)
# Build context deve ser a pasta pai (Códigos/)
COPY gam-config-puppeteer/models ../gam-config-puppeteer/models

# Copia o serviço
COPY gam-puppeteer-service/package*.json ./
RUN npm ci --omit=dev

COPY gam-puppeteer-service/lib ./lib
COPY gam-puppeteer-service/server.js ./

# browser-data é montado como volume externo (sessão do Chrome persiste)
VOLUME ["/app/browser-data"]

ENV PORT=3002
ENV CHROME_DEBUG_PORT=9222
ENV BROWSER_DATA_DIR=/app/browser-data
ENV DISPLAY=:99
# Porta do servidor VNC (x11vnc) que espelha o display :99 — usado para login manual no GAM
ENV VNC_PORT=5900

EXPOSE 3002
EXPOSE 5900

# Inicia Xvfb (display virtual), x11vnc (espelha :99 para login manual) e o servidor Node.
# x11vnc escuta em 0.0.0.0 dentro do container para o docker-proxy conseguir encaminhar;
# no host a porta é publicada só em 127.0.0.1 (compose), então o acesso externo é via túnel SSH.
CMD Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset & \
    sleep 2 && \
    x11vnc -display :99 -forever -shared -rfbport ${VNC_PORT} -nopw -quiet -bg && \
    node server.js
