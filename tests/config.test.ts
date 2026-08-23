import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  ENV_EXAMPLE,
  type EnvSource,
  githubAuth,
  LLM_ROLES,
  loadDotEnv,
  requireLlmConfig,
  requireLlmNames,
} from "../src/config.js";

const FULL: EnvSource = {
  LLM_PROVIDER: "openai",
  MODEL_EXTRACT: "gpt-cheap",
  MODEL_ANALYSE: "gpt-strong",
  OPENAI_API_KEY: "sk-test",
};

/** `.env.example` ships every variable declared and blank. Blank means unset. */
const BLANK: EnvSource = {
  LLM_PROVIDER: "",
  MODEL_EXTRACT: "  ",
  MODEL_ANALYSE: "",
  OPENAI_API_KEY: "",
  GITHUB_TOKEN: "",
};

function failure(role: "extract" | "analyse", env: EnvSource): ConfigError {
  try {
    requireLlmConfig(role, env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected requireLlmConfig to throw");
}

describe("requireLlmConfig", () => {
  it("routes each role to its own model variable", () => {
    expect(requireLlmConfig("extract", FULL).model).toBe("gpt-cheap");
    expect(requireLlmConfig("analyse", FULL).model).toBe("gpt-strong");
  });

  it("resolves the api key variable the selected provider reads", () => {
    expect(requireLlmConfig("extract", FULL).api_key).toBe("sk-test");
    expect(
      requireLlmConfig("extract", {
        ...FULL,
        LLM_PROVIDER: "anthropic",
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: "sk-ant",
      }).api_key,
    ).toBe("sk-ant");
  });

  it("does not require the other role's model", () => {
    expect(() => requireLlmConfig("analyse", { ...FULL, MODEL_EXTRACT: undefined })).not.toThrow();
  });

  it("names the missing variable and points at the template", () => {
    const error = failure("extract", { ...FULL, MODEL_EXTRACT: undefined });
    expect(error.variables).toEqual(["MODEL_EXTRACT"]);
    expect(error.message).toContain("MODEL_EXTRACT");
    expect(error.message).toContain(ENV_EXAMPLE);
  });

  it("treats a blank value as unset, not as an empty model name", () => {
    expect(failure("extract", BLANK).variables).toContain("LLM_PROVIDER");
    expect(failure("extract", { ...FULL, MODEL_EXTRACT: "   " }).variables).toEqual([
      "MODEL_EXTRACT",
    ]);
  });

  it("reports every missing variable at once", () => {
    const error = failure("extract", { LLM_PROVIDER: "openai" });
    expect(error.variables).toEqual(["MODEL_EXTRACT", "OPENAI_API_KEY"]);
  });

  it("asks only about the provider when the provider has no adapter", () => {
    const error = failure("extract", { ...FULL, LLM_PROVIDER: "gemini" });
    expect(error.variables).toEqual(["LLM_PROVIDER"]);
    expect(error.message).toContain("gemini");
    expect(error.message).toContain("openai, anthropic");
  });

  it("never serialises the api key", () => {
    const json = JSON.stringify(requireLlmConfig("extract", FULL));
    expect(json).not.toContain("sk-test");
    expect(JSON.parse(json)).toEqual({
      provider: "openai",
      role: "extract",
      model: "gpt-cheap",
      api_key: "[redacted]",
    });
  });
});

describe("requireLlmNames", () => {
  it("resolves the provider and the model for the role", () => {
    expect(requireLlmNames("extract", FULL)).toMatchObject({
      provider: "openai",
      role: "extract",
      model: "gpt-cheap",
    });
  });

  it("does not ask for the key of a call it will not make", () => {
    const keyless: EnvSource = { ...FULL, OPENAI_API_KEY: undefined };
    expect(() => requireLlmNames("extract", keyless)).not.toThrow();
    expect(() => requireLlmConfig("extract", keyless)).toThrow(ConfigError);
  });

  it("still names the variables it does need", () => {
    try {
      requireLlmNames("extract", BLANK);
      throw new Error("expected requireLlmNames to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).variables).toEqual(["LLM_PROVIDER", "MODEL_EXTRACT"]);
    }
  });

  it("rejects a provider with no adapter, the same way the full read does", () => {
    const bogus: EnvSource = { ...FULL, LLM_PROVIDER: "mistral" };
    expect(() => requireLlmNames("extract", bogus)).toThrow(/has no adapter/);
  });
});

describe("githubAuth", () => {
  it("treats an absent token as a degraded mode, not an error", () => {
    const auth = githubAuth({});
    expect(auth.mode).toBe("unauthenticated");
    expect(auth.token).toBeNull();
    expect(auth.note).toContain("GITHUB_TOKEN");
  });

  it("reads a token when one is set, and never serialises it", () => {
    const auth = githubAuth({ GITHUB_TOKEN: "ghp_secret" });
    expect(auth.mode).toBe("authenticated");
    expect(auth.token).toBe("ghp_secret");
    expect(JSON.stringify(auth)).not.toContain("ghp_secret");
  });

  it("treats a blank token as absent", () => {
    expect(githubAuth(BLANK).mode).toBe("unauthenticated");
  });
});

describe("import safety", () => {
  it("resolves the offline paths with a completely empty environment", () => {
    // The module is already imported by the time this runs; the assertion that
    // matters is that nothing threw on the way in, and that the paths a run
    // without an API key touches still work. See TICKET-0006.
    expect(LLM_ROLES).toEqual(["extract", "analyse"]);
    expect(githubAuth({}).mode).toBe("unauthenticated");
  });
});

describe("loadDotEnv", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempEnvFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-env-"));
    dirs.push(dir);
    const path = join(dir, ".env");
    writeFileSync(path, contents);
    return path;
  }

  it("reports a missing file rather than throwing", () => {
    expect(loadDotEnv(join(tmpdir(), "pipeline-env-does-not-exist", ".env"))).toBe(false);
  });

  it("loads a file that exists without overwriting the real environment", () => {
    const key = "PIPELINE_TEST_ONLY_VAR";
    const preset = "PIPELINE_TEST_PRESET_VAR";
    process.env[preset] = "from-shell";
    try {
      const path = tempEnvFile(`${key}=from-file\n${preset}=from-file\n`);
      expect(loadDotEnv(path)).toBe(true);
      expect(process.env[key]).toBe("from-file");
      expect(process.env[preset]).toBe("from-shell");
    } finally {
      delete process.env[key];
      delete process.env[preset];
    }
  });
});
