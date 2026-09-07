#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE=${SMARTHUB_ENV_FILE:-"$ROOT_DIR/config/.env"}
PROFILE_ENABLED=false
INITIALIZE=false
IMAGE_TAG=

usage() {
    cat >&2 <<'EOF'
Usage: scripts/update-nas.sh [--tag IMAGE_TAG] [--profile nas-monitor] [--initialize]

  --tag IMAGE_TAG        Pull the same published tag for SmartHub and NAS Monitor.
  --profile nas-monitor  Pull and start the optional Docker monitor service.
  --initialize            Create the SQLite schema only when no database exists.
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --tag)
            [ "$#" -ge 2 ] || { usage; exit 2; }
            IMAGE_TAG=$2
            case "$IMAGE_TAG" in
                ''|[.-]*|*[!A-Za-z0-9_.-]*)
                    printf '%s\n' "Invalid Docker image tag: $IMAGE_TAG" >&2
                    exit 2
                    ;;
            esac
            [ "${#IMAGE_TAG}" -le 128 ] || {
                printf '%s\n' "Docker image tag is longer than 128 characters" >&2
                exit 2
            }
            shift 2
            ;;
        --profile)
            [ "$#" -ge 2 ] || { usage; exit 2; }
            [ "$2" = "nas-monitor" ] || { usage; exit 2; }
            PROFILE_ENABLED=true
            shift 2
            ;;
        --initialize)
            INITIALIZE=true
            shift
            ;;
        -h|--help)
            usage >&1
            exit 0
            ;;
        *)
            usage
            exit 2
            ;;
    esac
done

[ -f "$ENV_FILE" ] || {
    printf '%s\n' "Missing deployment env file: $ENV_FILE" >&2
    exit 1
}

cd "$ROOT_DIR"

compose() {
    if [ "$PROFILE_ENABLED" = true ]; then
        if [ -n "$IMAGE_TAG" ]; then
            SMARTHUB_IMAGE= NAS_MONITOR_IMAGE= SMARTHUB_IMAGE_TAG="$IMAGE_TAG" \
                docker compose --env-file "$ENV_FILE" --profile nas-monitor "$@"
        else
            docker compose --env-file "$ENV_FILE" --profile nas-monitor "$@"
        fi
    else
        if [ -n "$IMAGE_TAG" ]; then
            SMARTHUB_IMAGE= NAS_MONITOR_IMAGE= SMARTHUB_IMAGE_TAG="$IMAGE_TAG" \
                docker compose --env-file "$ENV_FILE" "$@"
        else
            docker compose --env-file "$ENV_FILE" "$@"
        fi
    fi
}

# Validate interpolation and bind paths before touching the running stack.
compose config --quiet
printf '%s\n' 'Resolved image references:'
compose config --images

# Capture the current service's data-volume identity. If the Compose project
# name or deployment directory changed, a new prefixed volume could otherwise
# look like a successful clean install. Existing deployments must keep using
# the same volume; --initialize is never allowed to bypass this guard.
CURRENT_CONTAINER=$(compose ps -aq unifi-smarthub | sed -n '1p')
CURRENT_DATA_VOLUME=
if [ -n "$CURRENT_CONTAINER" ]; then
    CURRENT_DATA_VOLUME=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "$CURRENT_CONTAINER")
    [ -n "$CURRENT_DATA_VOLUME" ] || {
        printf '%s\n' 'Unable to identify the existing /app/data volume; refusing update' >&2
        exit 1
    }
fi

# Pull first; the current container keeps running while registry/network work
# happens. The subsequent preflight runs against the newly pulled image.
compose pull

if [ "$INITIALIZE" = true ]; then
    [ -z "$CURRENT_CONTAINER" ] || {
        printf '%s\n' 'Refusing --initialize while an existing SmartHub container is present' >&2
        exit 1
    }
    compose run --rm --no-deps unifi-smarthub node -e '
        const fs = require("node:fs");
        const path = require("node:path");
        const database = path.join(process.env.DATA_DIR, "smarthub.db");
        if (fs.existsSync(database)) {
            console.error("Refusing --initialize because smarthub.db already exists");
            process.exit(2);
        }
        const { createHistoryDb } = require("./db");
        const db = createHistoryDb(process.env.DATA_DIR);
        db.close();
    '
fi

# Fail closed before recreating the service. This checks the actual pulled
# image, the existing persistent DB, config permissions, and writer safety.
compose run --rm --no-deps unifi-smarthub node scripts/production-preflight.js --offline
compose up -d --no-build --pull never

if [ -n "$CURRENT_DATA_VOLUME" ]; then
    NEW_CONTAINER=$(compose ps -q unifi-smarthub | sed -n '1p')
    NEW_DATA_VOLUME=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "$NEW_CONTAINER")
    [ "$NEW_DATA_VOLUME" = "$CURRENT_DATA_VOLUME" ] || {
        printf '%s\n' "Data volume changed from $CURRENT_DATA_VOLUME to ${NEW_DATA_VOLUME:-<missing>}; refusing success" >&2
        exit 1
    }
fi

compose ps
