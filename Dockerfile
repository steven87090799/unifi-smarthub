FROM node:20-alpine

# tini 作為 PID 1，正確處理訊號與殭屍程序 (SSH 子連線清理)
# nut：提供 upsc 客戶端，容器內才能讀取 NAS/主機上 NUT server 的 UPS 數據 (UPS_SOURCE=nut)
# tzdata：時區資料，配合 TZ 環境變數讓報表排程/日誌時間正確 (預設 UTC 會差 8 小時)
RUN apk add --no-cache tini nut tzdata

WORKDIR /app

# 先複製套件清單以善用 Docker 層快取；有 lockfile 時用 npm ci 確保可重現建置
COPY package*.json ./
# better-sqlite3 is a native addon. Prebuilt binaries are used when available;
# these toolchain packages keep builds working on Alpine/architecture combinations
# without a prebuild.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps \
    && npm cache clean --force

# 複製應用程式原始碼 (.dockerignore 已排除 node_modules/.env/data 等)
COPY . .

# 建立資料持久化目錄並改用非 root 使用者執行
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 3000

# 容器內建健康檢查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
