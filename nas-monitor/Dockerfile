FROM node:24.18.0-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

RUN apk add --no-cache tini \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app
COPY --chown=node:node server.js ./server.js
COPY --chown=node:node build-identity.js ./build-identity.js

# Identity metadata is unique per release; keep it below the stable OS and
# source payload layers so those layers remain reusable across release tags.
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

# Release builds bake the strict policy into the image. The same validator runs
# here and again at process startup so incomplete or dirty identity fails closed.
RUN node -e "require('./build-identity').createRuntimeBuildIdentity(process.env)"

USER node

ENV NODE_ENV=production
ENV PORT=8000
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "const q=require('http').get('http://127.0.0.1:8000/health',r=>{r.resume();process.exit(r.statusCode===200?0:1)});q.setTimeout(4000,()=>{q.destroy();process.exit(1)});q.on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
