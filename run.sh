#!/bin/bash

if [[ "$NODE_ENV" == "development" || "$NODE_ENV" == "production" ]]; then
  if [ -z "$PROVIDERS" ]; then
    echo "Unsupported value of \$PROVIDERS=$PROVIDERS"
    exit 1
  fi
fi

mkdir -p "./storage/logs"
LOG_PATH="./storage/logs/debug-$(date +%s).log"

case "$NODE_ENV" in
  development)
    node banks.js ./conf/conf.json -s --public -b $PROVIDERS > LOG_PATH
    ;;
  production)
    DEBUG="" node banks.js ./conf/conf.json -s --public -b $PROVIDERS > LOG_PATH
    ;;
  test)
    npm test
    ;;
  "")
    npm test
    ;;
  *)
    echo "Unsupported value of \$NODE_ENV=$NODE_ENV"
    exit 1
    ;;
esac
