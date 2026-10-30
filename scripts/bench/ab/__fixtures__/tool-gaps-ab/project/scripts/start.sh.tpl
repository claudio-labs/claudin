#!/bin/sh
# Start inventory-svc in the background. The port comes from config/port and
# the server's output goes to server.log.
cd "$(dirname "$0")/.." || exit 1
nohup bun src/server.ts > server.log 2>&1 &
sleep 1
echo "inventory-svc started on port $(cat config/port)"
exit 0
