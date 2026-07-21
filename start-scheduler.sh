#!/bin/bash
cd /Users/martin/think/auto2

# Load env vars from .env
set -a
source .env
set +a

exec /opt/homebrew/bin/node scheduler.js daemon
