import { z } from "zod";

/**
 * The fact key vocabulary (TICKET-0020). `Fact.key` is what the rubric switches
 * on (ARCHITECTURE §2) and the contract deliberately leaves it as `string` —
 * this file is where the strings are decided.
 *
 * Four rules shape the list:
 *
 * 1. **Enumerated, not free-form.** A key outside this list is dropped at parse
 *    time, the same way an uncited fact is. The alternative — letting the model
 *    coin keys — moves the vocabulary into the model's head, and
 *    `src/analyse/score.ts` would then be matching English again, which is the
 *    thing ADR-0002 exists to prevent. The cost is real and is paid knowingly: a
 *    true observation that fits no key is lost rather than scored.
 *
 * 2. **Keys name observations, never verdicts.** `founder.prior_role` is a
 *    thing a page states; `founder.is_technical` would be a conclusion, and a
 *    conclusion in a key is the model scoring the company one field earlier than
 *    ADR-0002 allows. If a hint below reads like a rubric band, it is a bug.
 *
 * 3. **This file is not the thesis** (CLAUDE.md invariant 7). It says what may
 *    be *observed*; which keys feed which dimension, what they are worth, and
 *    what counts as enough of them is the rubric's, in `src/analyse/score.ts`
 *    and nowhere else. There is deliberately **no dimension field here** — the
 *    moment a key knows it is a "D1 key", the thesis lives in two files and the
 *    second copy is the one nobody updates.
 *
 * 4. **Mechanical keys stay in.** `traction.github_stars` is already a dated
 *    `Signal` (`src/evidence/signal.ts`) read straight off an API payload, so
 *    the model transcribing it adds a way to be wrong. It stays anyway, because
 *    the memo needs a *sentence* to print and a signal has none — stage 3 is
 *    templating, not prose. Which of the two the rubric trusts for the *number*
 *    is TICKET-0021's to decide, and the answer should be the signal. See STATE
 *    inconsistency 58.
 *
 * The list is unvalidated. It was written from SPEC §1–2 against four real
 * bundles' worth of evidence types, not from measurement of what a model
 * actually produces — there is no eval harness in v1 (SCOPE), and the first
 * captured extraction is the first evidence that these are the right 24 words.
 */

/** One key, and the sentence the prompt shows the model beside it. */
export interface FactKeyDef {
  key: string;
  /** What an observation filed here looks like. Rendered into `{{keys}}`. */
  hint: string;
}

/**
 * The vocabulary, grouped only for reading. Order is the order the model sees,
 * and it runs team → product → adoption → pull, which is the order a partner
 * reads a memo in.
 */
export const FACT_KEYS = [
  {
    key: "founder.name_role",
    hint: "A person named on the company's own pages, with the role it gives them.",
  },
  {
    key: "founder.prior_role",
    hint: "A prior employer, role or period a named person is stated to have held.",
  },
  {
    key: "founder.prior_exit",
    hint: "A company a named person is stated to have founded, sold, or left after building.",
  },
  {
    key: "founder.prior_artifact",
    hint: "Something a named person is stated to have built or shipped before this — a project, library, paper or talk.",
  },
  {
    key: "team.size_visible",
    hint: "How many people the source names or states, and where it names them.",
  },
  {
    key: "org.github_account_type",
    hint: "Whether the GitHub owner is an organisation or a personal account, as the payload states it.",
  },
  {
    key: "product.one_liner",
    hint: "How the company describes what the product does, in its own words.",
  },
  {
    key: "product.job",
    hint: "The specific task, and the person doing it, that the source says the product is for.",
  },
  {
    key: "product.category_claim",
    hint: "The category, platform or scope the company claims for itself — its own framing, quoted or closely paraphrased.",
  },
  {
    key: "product.capability_dependency",
    hint: "A technology, model or cost change the source says the product depends on, and when the source says it arrived.",
  },
  {
    key: "product.launch_date",
    hint: "A date the source gives for the company, the product, or a first release.",
  },
  {
    key: "product.open_source",
    hint: "A licence or public repository the source states for the product itself.",
  },
  {
    key: "product.runtime_position",
    hint: "Where the source says the product sits — agent, sidecar, proxy, kernel module, build step, hosted service.",
  },
  {
    key: "product.data_accumulated",
    hint: "Data the source says the product collects, stores or builds up as it is used.",
  },
  {
    key: "adoption.self_serve",
    hint: "A stated way to start using it without speaking to anyone — sign-up, free tier, download, install command.",
  },
  {
    key: "adoption.pricing_public",
    hint: "Whether prices are published, and what the page states them to be.",
  },
  {
    key: "adoption.sales_gate",
    hint: "A stated requirement to contact sales, book a demo, or request access before using it.",
  },
  {
    key: "traction.github_stars",
    hint: "A star count, with the date the record carries for it.",
  },
  {
    key: "traction.repo_activity",
    hint: "Commit, release or issue activity, with whatever dates the record gives.",
  },
  {
    key: "traction.contributors",
    hint: "How many people have contributed, as the payload states it.",
  },
  {
    key: "traction.named_user",
    hint: "A named customer, design partner or user the source states — a logo wall counts only if the page says they use it.",
  },
  {
    key: "traction.integration",
    hint: "A named third-party product or project the source says this works with.",
  },
  {
    key: "traction.hn_engagement",
    hint: "Points, comment count or dates on the Hacker News thread.",
  },
  {
    key: "funding.raised_usd",
    hint: "An amount, round, date or investor the source states.",
  },
] as const satisfies readonly FactKeyDef[];

export type FactKey = (typeof FACT_KEYS)[number]["key"];

/** Every key, in prompt order. */
export const FACT_KEY_LIST = FACT_KEYS.map((entry) => entry.key) as FactKey[];

const KEY_SET: ReadonlySet<string> = new Set<string>(FACT_KEY_LIST);

export function isFactKey(key: string): key is FactKey {
  return KEY_SET.has(key);
}

/**
 * The enum the extraction schema uses. Built from the list rather than written
 * twice — a key that reaches the model and not the parser would be a key the
 * prompt asks for and the pipeline throws away, silently.
 */
export const FactKeyEnum = z.enum(FACT_KEY_LIST as [FactKey, ...FactKey[]]);

/**
 * The `{{keys}}` block of `prompts/extract.v1.md`. A flat list: the groups above
 * are for a reader of this file, and showing them to the model would invite it
 * to file an observation by group when no key fits.
 */
export function renderKeys(keys: readonly FactKeyDef[] = FACT_KEYS): string {
  return keys.map((entry) => `- \`${entry.key}\` — ${entry.hint}`).join("\n");
}
