#!/bin/bash

if [[ "$NODE_ENV" == "development" || "$NODE_ENV" == "production" ]]; then
  if [ -z "$PROVIDERS" ]; then
    echo "Unsupported value of \$PROVIDERS=$PROVIDERS"
    exit 1
  fi
fi

case "$NODE_ENV" in
  development)
    ;;
  production)
    DEBUG=""
    ;;
  test)
    npm test
    exit 0
    ;;
  "")
    npm test
    exit 0
    ;;
  *)
    echo "Unsupported value of \$NODE_ENV=$NODE_ENV"
    exit 1
    ;;
esac

mkdir -p "./$STORAGE_PATH/logs"
LOG_PATH="./$STORAGE_PATH/logs/debug-$(date +%s).log"
DEBUG_FD=3

node banks.js ./conf/conf.json -s --public -b "$PROVIDERS" -d "$STORAGE_PATH" 3>"$LOG_PATH"
