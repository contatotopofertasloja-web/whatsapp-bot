# Usa Node 20 baseado em Debian (não tem snap)
FROM node:20-bullseye

# Instala Chromium e libs necessárias pro Puppeteer rodar
RUN apt-get update && apt-get install -y \
  chromium \
  chromium-common \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  libxshmfence1 \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Evita download do Chrome pelo puppeteer
ENV PUPPETEER_SKIP_DOWNLOAD=true
# Define o caminho do Chromium instalado pelo apt
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROME_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
