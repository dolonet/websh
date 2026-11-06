#!/bin/bash
# Browser scenarios (tests/e2e). Credentials come from the environment;
# tests/e2e/local.env.sh (not in git) is sourced first if it exists, so a
# machine can say once where its test account lives:
#   export E2E_SSH_HOST=203.0.113.7  E2E_SSH_USER=me
#   export E2E_SSH_PASSWORD="$(pass show test/ssh)"
#   export E2E_SUDO_PASSWORD="$E2E_SSH_PASSWORD"      # or passwordless sudo
cd "$(dirname "$0")/.." || exit 2
[ -f tests/e2e/local.env.sh ] && . tests/e2e/local.env.sh
exec node tests/e2e/run.mjs "$@"
