#!/usr/bin/env bash
# Dev helper: stop the dicomweb-pacs dev instance that listens on 5001.
set -u
PID="$(netstat -ano | grep LISTENING | grep ':5001 ' | awk '{print $5}' | head -1)"
if [ -z "$PID" ]; then
  echo "no listener on 5001"
  exit 0
fi
MSYS2_ARG_CONV_EXCL='*' taskkill /F /PID "$PID"
sleep 2
netstat -ano | grep LISTENING | grep -q ':5001 ' && echo "STILL LISTENING" || echo "port 5001 free"
