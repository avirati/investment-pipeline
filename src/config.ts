import { z } from "zod";

/**
 * Env parsing and model routing (TICKET-0006, ADR-0006). Three rules shape this
 * file, and the tests exist to keep them true:
 *
 * 1. **Nothing is validated at import.** `./pipeline memo` and `pnpm test` run
 *    with no `.env` at all, so this module must be importable — and its offline
 *    paths callable — with a completely empty environment. Validation happens at
 *    the moment an LLM call is about to be made, not a moment earlier.
 *
 * 2. **A failure names the variable.** "missing configuration" with no name is a
 *    riddle. Every problem reported here says which variable, what it is for,
 *    and where the template lives.
 *
 * 3. **Secrets are not serialisable.** Run manifests are committed to the repo
 *    (ARCHITECTURE §4), so the two config objects that hold a secret redact it
 *    in `toJSON` rather than trusting every future caller to remember.
 */

export const ENV_EXAMPLE = ".env.example";

/** `process.env`, or anything shaped like it. Injectable so tests need no globals. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * One line per variable, phrased to be readable at the end of "not set — ".
 * This is the single source of the description text; `.env.example` is the long
 * form of the same thing.
 */
const VARIABLES = {
  LLM_PROVIDER: "which provider adapter to construct",
  MODEL_EXTRACT: "model for the mechanical extract role (evidence bundle → facts)",
  MODEL_ANALYSE: "model for the judgement-heavy analyse role (query planning)",
  OPENAI_API_KEY: "API key for LLM_PROVIDER=openai",
  ANTHROPIC_API_KEY: "API key for LLM_PROVIDER=anthropic",
  GITHUB_TOKEN: "raises the GitHub rate limit from 60/hr to 5000/hr",
} as const;

export type EnvVariable = keyof typeof VARIABLES;

export interface ConfigProblem {
  variable: EnvVariable;
  /** Reads as a sentence after the variable name. Never contains a secret. */
  detail: string;
}

/**
 * A run that needs configuration it does not have. The CLI maps this to
 * `EXIT.USAGE` — it is the operator's environment being wrong, not a bug.
 */
export class ConfigError extends Error {
  readonly problems: readonly ConfigProblem[];

  constructor(summary: string, problems: readonly ConfigProblem[]) {
    const width = Math.max(0, ...problems.map((p) => p.variable.length));
    super(
      [
        summary,
        ...problems.map((p) => `  ${p.variable.padEnd(width)}  ${p.detail}`),
        `Set these in .env — see ${ENV_EXAMPLE}.`,
      ].join("\n"),
    );
    this.name = "ConfigError";
    this.problems = problems;
  }

  /** The variables at fault, for a caller that wants to react rather than print. */
  get variables(): EnvVariable[] {
    return this.problems.map((p) => p.variable);
  }
}

/**
 * Env values are strings or absent, and an empty value means absent. `.env.example`
 * ships every variable declared and blank, so `MODEL_EXTRACT=` must read as "not
 * set" rather than as the empty model name.
 */
const EnvValue = z
  .string()
  .optional()
  .transform((raw) => {
    const value = raw?.trim();
    return value === undefined || value === "" ? undefined : value;
  });

/** Providers with an adapter in `src/llm/provider.ts`. Adding one is a case there. */
export const LLM_PROVIDERS = ["openai", "anthropic"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** The API key variable each provider reads. */
const KEY_VARIABLE = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
} as const satisfies Record<LlmProvider, EnvVariable>;

/**
 * Two roles, routed separately so the high-volume mechanical job never silently
 * rides on the expensive model (ADR-0006). Neither role ever produces a score, a
 * call, or memo prose (ADR-0002).
 */
const MODEL_VARIABLE = {
  extract: "MODEL_EXTRACT",
  analyse: "MODEL_ANALYSE",
} as const satisfies Record<string, EnvVariable>;

export type LlmRole = keyof typeof MODEL_VARIABLE;
export const LLM_ROLES = Object.keys(MODEL_VARIABLE) as LlmRole[];

/**
 * Provider and model, without the key — everything that names a call and
 * nothing that authorises one.
 *
 * It exists because `--replay` answers from the committed cache and never
 * reaches a provider (`callModel`, rule 4), while the cache key is built from
 * the provider's and the model's *names*. Demanding `OPENAI_API_KEY` for a
 * request that will not be sent is rule 1 of this file broken in the direction
 * nobody notices: failing early for a variable the run will never read.
 */
export interface LlmNames {
  provider: LlmProvider;
  role: LlmRole;
  model: string;
}

export interface LlmConfig {
  provider: LlmProvider;
  role: LlmRole;
  model: string;
  /** Redacted by `toJSON`; see rule 3 at the top of this file. */
  api_key: string;
  toJSON(): { provider: LlmProvider; role: LlmRole; model: string; api_key: "[redacted]" };
}

const RawLlmEnv = z.object({
  LLM_PROVIDER: EnvValue,
  MODEL_EXTRACT: EnvValue,
  MODEL_ANALYSE: EnvValue,
  OPENAI_API_KEY: EnvValue,
  ANTHROPIC_API_KEY: EnvValue,
});

function notSet(variable: EnvVariable): string {
  return `not set — ${VARIABLES[variable]}`;
}

type Complain = (variable: EnvVariable, detail: string) => void;

/**
 * The half of the environment that names a call rather than authorises one.
 * Shared by both readers below so that "which provider" and "which model" are
 * decided in one place; the key is the only thing they disagree about.
 */
function readNames(
  env: z.infer<typeof RawLlmEnv>,
  role: LlmRole,
  problem: Complain,
): { provider: LlmProvider | null; model: string | null } {
  const provider = env.LLM_PROVIDER;
  if (provider === undefined) {
    problem("LLM_PROVIDER", `${notSet("LLM_PROVIDER")} — one of: ${LLM_PROVIDERS.join(", ")}`);
  } else if (!(LLM_PROVIDERS as readonly string[]).includes(provider)) {
    problem("LLM_PROVIDER", `'${provider}' has no adapter — one of: ${LLM_PROVIDERS.join(", ")}`);
  }

  const modelVariable = MODEL_VARIABLE[role];
  const model = env[modelVariable];
  if (model === undefined) problem(modelVariable, notSet(modelVariable));

  const usable =
    provider !== undefined && (LLM_PROVIDERS as readonly string[]).includes(provider)
      ? (provider as LlmProvider)
      : null;
  return { provider: usable, model: model ?? null };
}

/**
 * Role-specific on purpose. Stage 1 plans queries with `analyse` long before
 * `extract` is configured, and failing a run for a variable it will never read
 * is the "fail late" rule broken in the other direction.
 */
function llmConfigSchema(role: LlmRole) {
  return RawLlmEnv.transform((env, ctx): LlmConfig => {
    const problem: Complain = (variable, detail) => {
      ctx.addIssue({ code: "custom", path: [variable], message: detail });
    };

    const { provider, model } = readNames(env, role, problem);

    // The key variable is only knowable once the provider is, so an unusable
    // LLM_PROVIDER reports alone rather than guessing which key to ask for.
    let apiKey: string | undefined;
    if (provider !== null) {
      const keyVariable = KEY_VARIABLE[provider];
      apiKey = env[keyVariable];
      if (apiKey === undefined) problem(keyVariable, notSet(keyVariable));
    }

    if (provider === null || model === null || apiKey === undefined) return z.NEVER;

    return {
      provider,
      role,
      model,
      api_key: apiKey,
      toJSON: () => ({ provider, role, model, api_key: "[redacted]" }),
    };
  });
}

function llmNamesSchema(role: LlmRole) {
  return RawLlmEnv.transform((env, ctx): LlmNames => {
    const { provider, model } = readNames(env, role, (variable, detail) => {
      ctx.addIssue({ code: "custom", path: [variable], message: detail });
    });
    return provider === null || model === null ? z.NEVER : { provider, role, model };
  });
}

function toConfigError(error: z.ZodError, summary: string): ConfigError {
  return new ConfigError(
    summary,
    error.issues.map((issue) => ({
      variable: String(issue.path[0]) as EnvVariable,
      detail: issue.message,
    })),
  );
}

/**
 * Resolve the provider, model and key for one role, or throw naming what is
 * missing. Call this immediately before constructing a model — never at module
 * load, and never on a path that runs offline.
 */
export function requireLlmConfig(role: LlmRole, env: EnvSource = process.env): LlmConfig {
  const result = llmConfigSchema(role).safeParse(env);
  if (result.success) return result.data;
  throw toConfigError(result.error, `LLM configuration for the '${role}' role is incomplete:`);
}

/**
 * The same resolution minus the key, for a path that will not make a call.
 * Never call this before a real call: a run that is about to spend money should
 * fail on a missing key here, not inside the provider.
 */
export function requireLlmNames(role: LlmRole, env: EnvSource = process.env): LlmNames {
  const result = llmNamesSchema(role).safeParse(env);
  if (result.success) return result.data;
  throw toConfigError(result.error, `LLM configuration for the '${role}' role is incomplete:`);
}

export type GithubMode = "authenticated" | "unauthenticated";

export interface GithubAuth {
  token: string | null;
  mode: GithubMode;
  /** Manifest-ready, so a reader of a thin run can see why it was thin. */
  note: string;
  toJSON(): { mode: GithubMode; note: string };
}

/**
 * No token is a degraded mode, not an error (ADR-0004): unauthenticated GitHub
 * is 60 requests/hour, which is enough for a small run and not enough for a
 * large one. Either way the answer goes in the manifest.
 */
export function githubAuth(env: EnvSource = process.env): GithubAuth {
  const token = EnvValue.parse(env.GITHUB_TOKEN) ?? null;
  const mode: GithubMode = token === null ? "unauthenticated" : "authenticated";
  const note =
    token === null
      ? `GITHUB_TOKEN not set — 60 GitHub requests/hour; coverage may be lower. ${VARIABLES.GITHUB_TOKEN}`
      : "GITHUB_TOKEN present — 5000 GitHub requests/hour.";
  return { token, mode, note, toJSON: () => ({ mode, note }) };
}

/**
 * Load `.env` into `process.env` if it is there. Real environment variables win:
 * Node's loader does not overwrite what is already set, so CI can override a
 * committed default without editing a file.
 *
 * Called once from the CLI entrypoint, never at import — a test or a library
 * caller gets the environment it actually has. Returns whether a file was read.
 */
export function loadDotEnv(path = ".env"): boolean {
  try {
    process.loadEnvFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
