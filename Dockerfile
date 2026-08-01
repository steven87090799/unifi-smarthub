FROM node:24.18.0-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

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
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# 複製應用程式原始碼 (.dockerignore 已排除 node_modules/.env/data 等)
COPY . .

# Release identity changes for every build. Declare it only after the locked
# dependencies and source payload so metadata changes invalidate identity
# layers, not an otherwise identical runtime filesystem.
ARG BUILD_VERSION=""
ARG BUILD_REVISION=""
ARG BUILD_CREATED=""
ARG BUILD_DIRTY=""
ARG BUILD_IDENTITY_REQUIRED="false"

ENV BUILD_VERSION=${BUILD_VERSION} \
    BUILD_REVISION=${BUILD_REVISION} \
    BUILD_CREATED=${BUILD_CREATED} \
    BUILD_DIRTY=${BUILD_DIRTY} \
    BUILD_IDENTITY_REQUIRED=${BUILD_IDENTITY_REQUIRED}

LABEL org.opencontainers.image.source="https://github.com/steven87090799/unifi-smarthub" \
      org.opencontainers.image.version=${BUILD_VERSION} \
      org.opencontainers.image.revision=${BUILD_REVISION} \
      org.opencontainers.image.created=${BUILD_CREATED} \
      io.smarthub.build.dirty=${BUILD_DIRTY}

# Release builds set BUILD_IDENTITY_REQUIRED=true. Development images remain
# buildable but expose an incomplete identity instead of pretending to be a release.
RUN if [ "$BUILD_IDENTITY_REQUIRED" = "true" ]; then \
      node -e "require('./observability/build-identity').createBuildIdentity(process.env,{requireClean:true})"; \
    fi

# 建立資料持久化目錄並改用非 root 使用者執行
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV SMARTHUB_BIND_ADDRESS=0.0.0.0
EXPOSE 3000
STOPSIGNAL SIGTERM

# readiness 是容器健康的權威信號：除了 HTTP process，也檢查 SQLite 與 worker。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const q=require('http').get('http://127.0.0.1:3000/health/ready',r=>{r.resume();process.exit(r.statusCode===200?0:1)});q.setTimeout(4000,()=>{q.destroy();process.exit(1)});q.on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
