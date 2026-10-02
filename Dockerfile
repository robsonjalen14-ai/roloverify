FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
# one service runs both: dashboard site (foreground) + discord bot (background).
# no bot token configured? bot exits on its own, site keeps humming.
CMD ["sh", "-c", "node bot.js & node server.js"]
