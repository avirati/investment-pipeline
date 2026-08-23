#!/usr/bin/env bash
# Setup for a fresh clone. Idempotent: safe to re-run, never overwrites .env.
# Steps follow docs/ARCHITECTURE.md §7.1. This is a setup script, not a task
# runner (CLAUDE.md) — it installs and verifies, and nothing else.
set -euo pipefail
cd "$(dirname "$0")"

REQUIRED_NODE_MAJOR=22

step() { printf '\n[%s/6] %s\n' "$1" "$2"; }
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
# ARCHITECTURE §7.1 step 6. Re-renders the committed sample run from the
# artifacts in the repo: no network, no API key, no model call. It is the last
# step because it is the only one that exercises the pipeline rather than the
# toolchain — if this passes on a fresh clone, SCOPE #11's promise holds.
SAMPLE_RUN='2026-08-23-ai-agent-infrastructure'
step 6 "Offline self-verification (./pipeline memo --run ${SAMPLE_RUN})"
if [ ! -d "runs/${SAMPLE_RUN}" ]; then
  fail "runs/${SAMPLE_RUN} is missing — the committed sample run should be in this clone."
fi
./pipeline memo --run "${SAMPLE_RUN}" >/dev/null || fail "the committed sample run did not re-render."
info "12 memos re-rendered from committed artifacts — no network, no key"

printf '\nSetup complete. Next:\n'
printf "  ./pipeline --help\n"
printf "  pnpm test          # offline, no API key needed\n"
printf "  open memos/${SAMPLE_RUN}/     # the committed sample run\n"
