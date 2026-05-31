# AI Media Studio — Node + ffmpeg (para el futuro editor de vídeo)
FROM node:20-slim

# ffmpeg para edición/concatenación de vídeo (Fase B del editor)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instalar dependencias primero (mejor cache de capas)
COPY package*.json ./
RUN npm install --omit=dev

# Copiar el resto de la app
COPY . .

# Crear carpetas de uploads por si no vienen en el repo
RUN mkdir -p public/uploads/images public/uploads/videos

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
