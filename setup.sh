#!/usr/bin/env bash
# Setup for a fresh clone. Idempotent: safe to re-run, never overwrites .env.
# Steps follow docs/ARCHITECTURE.md §7.1. This is a setup script, not a task
# runner (CLAUDE.md) — it installs and verifies, and nothing else.
set -euo pipefail
cd "$(dirname "$0")"

REQUIRED_NODE_MAJOR=22

step() { printf '\n[%s/5] %s\n' "$1" "$2"; }
info() { printf '      %s\n' "$1"; }
fail() { printf '\nsetup.sh: %s\n' "$1" >&2; exit 1; }

printf 'investment-pipeline — setup\n'

# --- 1. node ----------------------------------------------------------------
step 1 'Checking Node version'
command -v node >/dev/null 2>&1 || fail "node not found on PATH. Install Node ${REQUIRED_NODE_MAJOR} or newer."
node_version="$(node --version)"                 # e.g. v22.11.0
node_major="${node_version#v}"; node_major="${node_major%%.*}"
if [ "${node_major}" -lt "${REQUIRED_NODE_MAJOR}" ]; then
  fail "Node ${REQUIRED_NODE_MAJOR}+ is required, found ${node_version} ($(command -v node))."
fi
info "found ${node_version} — ok"

# --- 2. pnpm ----------------------------------------------------------------
# corepack ships with node and pins the version in package.json#packageManager,
# so it is preferred. The npm fallback exists for environments where corepack
# is disabled or unavailable.
step 2 'Ensuring pnpm is available'
if corepack enable pnpm >/dev/null 2>&1; then
  info "enabled via corepack"
elif command -v pnpm >/dev/null 2>&1; then
  info "corepack unavailable; using the pnpm already on PATH"
else
  info "corepack unavailable; falling back to 'npm i -g pnpm'"
  npm i -g pnpm >/dev/null || fail "could not install pnpm. Install it manually: https://pnpm.io/installation"
fi
command -v pnpm >/dev/null 2>&1 || fail "pnpm still not on PATH after setup."
info "pnpm $(pnpm --version) at $(command -v pnpm)"

# --- 3. dependencies --------------------------------------------------------
step 3 'Installing dependencies (pnpm install --frozen-lockfile)'
pnpm install --frozen-lockfile
info "dependencies installed"

# --- 4. .env ----------------------------------------------------------------
step 4 'Preparing .env'
if [ -f .env ]; then
  info ".env already present — left untouched"
else
  cp .env.example .env
  info ".env created from .env.example"
  info "Fill in LLM_PROVIDER, the matching API key, MODEL_EXTRACT and MODEL_ANALYSE"
  info "before running 'source' or 'analyse'. 'memo' needs neither (ARCHITECTURE §7.1)."
fi

# --- 5. typecheck -----------------------------------------------------------
step 5 'Type-checking (pnpm typecheck)'
pnpm typecheck
info "typecheck clean"

# --- 6. offline self-verification -------------------------------------------
# TODO(0028): ARCHITECTURE §7.1 step 6 re-renders the committed sample run —
# `./pipeline memo --run <committed_sample>` — to prove the toolchain works with
# no network and no API key. It cannot run yet: `memo` exits 70 until
# TICKET-0026, and there is no committed sample run until TICKET-0028. That
# ticket adds this step and is what closes the SCOPE #11 promise.
printf '\nSetup complete. Next:\n'
printf "  ./pipeline --help\n"
printf "  pnpm test          # offline, no API key needed\n"
printf '\nNote: the offline self-verification step (ARCHITECTURE §7.1 step 6) is not\n'
printf 'wired up yet — it arrives with the committed sample run (TICKET-0028).\n'
