import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractHtml } from "../src/evidence/fetch.js";
import {
  absoluteLink,
  type DiscoveredLink,
  detectEmptyShell,
  detectLanguage,
  discoverLinks,
  englishRatio,
  extractPeople,
  FETCHED_ROLES,
  LINK_RULES,
  looksLikeName,
  MAX_PEOPLE,
  pickPages,
  SHELL_MAX_CHARS,
  SITE_PAGE_BUDGET,
  sameSite,
  siteHost,
} from "../src/evidence/site.js";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

const corootHome = fixture("sites/coroot-home.html");
const corootAbout = fixture("sites/coroot-about.html");
const ravenlake = fixture("company-site.html");

const HOME = "https://coroot.com/";

const roleUrls = (links: readonly DiscoveredLink[], role: string): string[] =>
  links.filter((link) => link.role === role).map((link) => link.url);

describe("absoluteLink", () => {
  it("resolves a relative href against the page it was found on", () => {
    expect(absoluteLink("/about", HOME)).toBe("https://coroot.com/about");
    expect(absoluteLink("about", "https://coroot.com/company/")).toBe(
      "https://coroot.com/company/about",
    );
  });

  it("drops the fragment so two links to one page dedup", () => {
    expect(absoluteLink("/pricing#plans", HOME)).toBe("https://coroot.com/pricing");
  });

  it("rejects what is not a page: anchors, mailto, tel, javascript", () => {
    for (const href of [
      "#main-content",
      "",
      "   ",
      "mailto:hi@coroot.com",
      "tel:+1",
      "javascript:void(0)",
    ]) {
      expect(absoluteLink(href, HOME)).toBeNull();
    }
  });

  it("rejects non-http schemes that parse as urls", () => {
    expect(absoluteLink("ftp://files.coroot.com/x", HOME)).toBeNull();
  });
});

describe("sameSite", () => {
  it("treats a subdomain as the company's own", () => {
    expect(sameSite("https://docs.coroot.com/", HOME)).toBe(true);
    expect(sameSite("https://coroot.com/about", "https://docs.coroot.com/")).toBe(true);
  });

  it("ignores www", () => {
    expect(sameSite("https://www.coroot.com/about", HOME)).toBe(true);
  });

  it("is false for an unrelated host", () => {
    expect(sameSite("https://twitter.com/coroot", HOME)).toBe(false);
  });

  /**
   * The known wrong answer, pinned rather than papered over: without a public
   * suffix list two accounts on one shared host look like one site. It errs
   * towards rejecting the link, which costs a page rather than mixing two
   * companies' evidence — see the note on `sameSite`.
   */
  it("does not confuse two accounts on a shared host", () => {
    expect(sameSite("https://b.github.io/", "https://a.github.io/")).toBe(false);
  });

  it("returns false rather than throwing on an unparseable url", () => {
    expect(sameSite("not a url", HOME)).toBe(false);
    expect(siteHost("not a url")).toBeNull();
  });
});

describe("discoverLinks", () => {
  const links = discoverLinks(corootHome, HOME);

  it("finds the team page on a real company site", () => {
    expect(roleUrls(links, "team")).toContain("https://coroot.com/about");
  });

  it("finds the two D-4 surfaces the home page actually offers", () => {
    // coroot names its pricing page `/editions`, which no link-text rule would
    // catch — this is why the path list carries the word.
    expect(roleUrls(links, "pricing")).toContain("https://coroot.com/editions");
    expect(roleUrls(links, "docs")).toContain("https://docs.coroot.com/");
  });

  it("keeps the code host, which is the one off-site role worth recording", () => {
    const repo = links.find((link) => link.role === "repo");
    expect(repo?.url).toBe("https://github.com/coroot/coroot");
    expect(repo?.same_site).toBe(false);
  });

  it("records a sign-up path and a demo path as separate roles", () => {
    expect(roleUrls(links, "signup")).toContain("https://coroot.com/account/signup");
    expect(roleUrls(links, "contact")).toContain("https://coroot.com/get-demo");
  });

  it("drops off-site links that are not code hosts", () => {
    for (const link of links) {
      expect(link.same_site || link.role === "repo").toBe(true);
    }
    expect(links.map((link) => link.url)).not.toContain(
      "https://bsky.app/profile/coroot.bsky.social",
    );
  });

  it("drops the chrome: assets, fonts, blog posts and legal pages", () => {
    const urls = links.map((link) => link.url);
    expect(urls.some((url) => url.includes("/assets/"))).toBe(false);
    expect(urls.some((url) => url.includes("fonts.googleapis"))).toBe(false);
    expect(urls).not.toContain("https://coroot.com/privacy");
  });

  it("deduplicates by url and keeps the first occurrence, which is the nav", () => {
    const urls = links.map((link) => link.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("classifies by link text when the path says nothing", () => {
    const html = `<a href="/x7f2">Get started</a><a href="/q1">Our team</a>`;
    const found = discoverLinks(html, HOME);
    expect(found.map((link) => [link.role, link.url])).toEqual([
      ["signup", "https://coroot.com/x7f2"],
      ["team", "https://coroot.com/q1"],
    ]);
    expect(found[0]?.matched).toContain("link text");
  });

  it("reads an icon-only link's aria-label as its text", () => {
    const html = `<a href="/z" aria-label="Book a demo"><svg></svg></a>`;
    expect(discoverLinks(html, HOME)[0]?.role).toBe("contact");
  });

  it("names the rule that fired, so a wrong guess is readable", () => {
    for (const link of links) {
      expect(link.matched).toMatch(/\((host|path|link text)\)$/);
    }
  });

  it("returns nothing for a page with no anchors, rather than throwing", () => {
    expect(discoverLinks("<html><body><p>hi</p></body></html>", HOME)).toEqual([]);
  });

  it("prefers the more specific role when a path could match two rules", () => {
    // `/pricing` under a sign-up rule would be wrong; `/get-started` under a
    // pricing rule would be too. The rules are ordered, and this pins it.
    expect(discoverLinks(`<a href="/get-started">Pricing</a>`, HOME)[0]?.role).toBe("signup");
    expect(discoverLinks(`<a href="/pricing">Plans</a>`, HOME)[0]?.role).toBe("pricing");
  });
});

describe("pickPages", () => {
  it("reads team first, then pricing, then docs", () => {
    const picked = pickPages(discoverLinks(corootHome, HOME));
    expect(picked.map((link) => link.role)).toEqual([...FETCHED_ROLES]);
  });

  it("never spends more than the budget", () => {
    const picked = pickPages(discoverLinks(corootHome, HOME), 1);
    expect(picked).toHaveLength(1);
    expect(picked[0]?.role).toBe("team");
  });

  it("takes one page per role, not every match", () => {
    const html = `<a href="/about">About</a><a href="/team">Team</a><a href="/company">Company</a>`;
    const picked = pickPages(discoverLinks(html, HOME));
    expect(picked.map((link) => link.url)).toEqual(["https://coroot.com/about"]);
  });

  it("never fetches a sign-up form, a demo form or the repository", () => {
    for (const role of ["signup", "contact", "repo"]) {
      expect(FETCHED_ROLES).not.toContain(role);
    }
    expect(SITE_PAGE_BUDGET).toBe(FETCHED_ROLES.length);
  });

  it("skips an off-site page even when its role is fetchable", () => {
    const links: DiscoveredLink[] = [
      {
        url: "https://readthedocs.io/acme",
        role: "docs",
        text: "Docs",
        matched: "x",
        same_site: false,
      },
    ];
    expect(pickPages(links)).toEqual([]);
  });

  it("returns an empty list when a site links nowhere useful", () => {
    expect(pickPages([])).toEqual([]);
  });
});

describe("detectEmptyShell", () => {
  it("passes a real page through", () => {
    const verdict = detectEmptyShell(extractHtml(corootHome), corootHome);
    expect(verdict.empty).toBe(false);
    expect(verdict.reason).toBeNull();
    expect(verdict.chars).toBeGreaterThan(SHELL_MAX_CHARS);
  });

  it("names client-side rendering when the page is a mount element and scripts", () => {
    const html =
      `<html><head><title>Acme</title></head><body><div id="root"></div>` +
      `<script src="/app.js"></script></body></html>`;
    const verdict = detectEmptyShell(extractHtml(html), html);
    expect(verdict.empty).toBe(true);
    expect(verdict.reason).toContain("renders client-side");
    expect(verdict.reason).toContain("does not run a browser");
  });

  it("reports a thin page as thin rather than as client-rendered", () => {
    const html = `<html><body><p>Coming soon.</p></body></html>`;
    const verdict = detectEmptyShell(extractHtml(html), html);
    expect(verdict.empty).toBe(true);
    expect(verdict.reason).toContain("characters of extractable text");
    expect(verdict.reason).not.toContain("client-side");
  });

  it("is a verdict and never an exception, even on markup that is not a page", () => {
    expect(() => detectEmptyShell(extractHtml(""), "")).not.toThrow();
    expect(detectEmptyShell(extractHtml(""), "").empty).toBe(true);
  });
});

describe("detectLanguage", () => {
  const english = (html: string) => detectLanguage(html, extractHtml(html).text);

  it("accepts a real English company site", () => {
    expect(english(corootHome).verdict).toBe("english");
    expect(english(ravenlake).verdict).toBe("english");
  });

  it("takes the page's own declaration when it is not English", () => {
    const html = `<html lang="de"><body><p>Wir bauen Software.</p></body></html>`;
    const check = english(html);
    expect(check.verdict).toBe("not_english");
    expect(check.declared).toBe("de");
    expect(check.reason).toContain('lang="de"');
  });

  it("accepts a regional English tag", () => {
    expect(english(`<html lang="en-GB"><body><p>Hello.</p></body></html>`).verdict).toBe("english");
  });

  /**
   * `lang="en"` on a page that is plainly not English is a template default,
   * and it is the case the script test exists for.
   */
  it("lets a dominant non-Latin script overrule the declared language", () => {
    const html = `<html lang="en"><body><p>私たちは開発者のためのインフラを構築しています。</p></body></html>`;
    const check = english(html);
    expect(check.verdict).toBe("not_english");
    expect(check.script).toBe("cjk");
    expect(check.reason).toContain("cjk");
  });

  it("catches Latin-script prose that is not English by its stopwords", () => {
    const spanish =
      "Construimos infraestructura para desarrolladores que necesitan observabilidad " +
      "continua sin instrumentar nada manualmente, porque el tiempo de los ingenieros " +
      "vale mucho mas que las licencias tradicionales del mercado actual. Nuestra " +
      "plataforma correlaciona metricas, registros y trazas automaticamente, y explica " +
      "la causa raiz de cada incidente en lenguaje claro para el equipo de guardia.";
    const html = `<html><body><p>${spanish}</p></body></html>`;
    const check = english(html);
    expect(check.verdict).toBe("not_english");
    expect(check.english_ratio).toBeLessThan(0.1);
  });

  it("says unknown rather than guessing on a page with almost no text", () => {
    const check = english(`<html><body><p>Acme</p></body></html>`);
    expect(check.verdict).toBe("unknown");
    expect(check.english_ratio).toBeNull();
    expect(check.reason).toContain("too little text");
  });

  it("returns null for a ratio over too few tokens", () => {
    expect(englishRatio("the of and to a")).toBeNull();
  });
});

describe("the hand-written rule lists", () => {
  it("gives every rule a name, because the name is what a reviewer reads", () => {
    for (const rule of LINK_RULES) {
      expect(rule.name.length).toBeGreaterThan(0);
      expect(rule.host ?? rule.path ?? rule.text).toBeDefined();
    }
  });
});

describe("looksLikeName", () => {
  it("accepts ordinary two- and three-token names, particles and initials", () => {
    for (const name of [
      "Nikolay Sivko",
      "Priya Raghavan",
      "Ada M. Lovelace",
      "Jan van Dijk",
      "María José Ruiz",
      "Seán O’Brien",
    ]) {
      expect(looksLikeName(name), name).toBe(true);
    }
  });

  it("rejects headings and calls to action that happen to be title-cased", () => {
    for (const value of [
      "Meet The Team",
      "Get Started",
      "Read More",
      "Privacy Policy",
      "Cookie Settings",
      "Why We Built Coroot",
      "Zero Instrumentation",
    ]) {
      expect(looksLikeName(value), value).toBe(false);
    }
  });

  it("rejects a job title, so nobody is ever called Head", () => {
    expect(looksLikeName("Head Of Engineering")).toBe(false);
    expect(looksLikeName("Chief Technology Officer")).toBe(false);
  });

  it("rejects one token, five tokens, digits and markup leftovers", () => {
    expect(looksLikeName("Nikolay")).toBe(false);
    expect(looksLikeName("A B C D E")).toBe(false);
    expect(looksLikeName("Suite 400 Boston")).toBe(false);
    expect(looksLikeName("Contact (us)")).toBe(false);
  });

  it("rejects initials alone: two capitals are not two names", () => {
    expect(looksLikeName("J. R.")).toBe(false);
  });

  it("rejects the empty string and a paragraph, rather than throwing", () => {
    expect(looksLikeName("")).toBe(false);
    expect(looksLikeName("x".repeat(200))).toBe(false);
  });
});

describe("extractPeople", () => {
  it("names the three people on a real team page, with their roles verbatim", () => {
    const { people, skipped } = extractPeople(corootAbout, "team");
    expect(skipped).toBeNull();
    expect(people.map((person) => [person.name, person.role])).toEqual([
      ["Nikolay Sivko", "Co-founder, CEO"],
      ["Peter Zaitsev", "Co-founder, Advisor"],
      ["Alexander Lamberton", "Marketing Manager"],
    ]);
  });

  /**
   * The marketing manager is emitted alongside the two co-founders on purpose.
   * Deciding who is a founder is SPEC D1's job and lives in the rubric
   * (invariant 7); this module reports who is named and what the page calls
   * them.
   */
  it("does not decide who counts as a founder", () => {
    const { people } = extractPeople(corootAbout, "team");
    expect(people.some((person) => /manager/i.test(person.role))).toBe(true);
  });

  it("reads a hand-written team list where name and role share a line", () => {
    const { people } = extractPeople(ravenlake, "home");
    expect(people.map((person) => person.name)).toEqual(["Priya Raghavan", "Tom Okafor"]);
    expect(people[0]?.matched).toBe("name and role on one line");
    expect(people[1]?.role).toContain("founded Bellhouse");
  });

  it("scans a home page only under a heading that says team", () => {
    const { people, skipped } = extractPeople(corootHome, "home");
    expect(people).toEqual([]);
    expect(skipped).toBe("the page names no team section");
  });

  it("carries the surrounding block, so an extraction can be checked by hand", () => {
    const { people } = extractPeople(corootAbout, "team");
    expect(people[0]?.context).toContain("On a mission to make troubleshooting");
    expect(people[0]?.context.length).toBeLessThanOrEqual(240);
  });

  it("drops a name with no role beside it, and says so", () => {
    const html = `<body><section><h3>Nikolay Sivko</h3><p>Loves observability.</p></section></body>`;
    const { people, rejected } = extractPeople(html, "team");
    expect(people).toEqual([]);
    expect(rejected).toEqual([
      { name: "Nikolay Sivko", reason: "no role or prior position stated beside the name" },
    ]);
  });

  it("drops a quoted testimonial rather than reading the customer as staff", () => {
    const html =
      `<body><section><h3>Dana Whitfield</h3><p>VP Engineering</p>` +
      `<p>“We cut our mean time to resolution in half within a fortnight of rolling it out.”</p>` +
      `</section></body>`;
    const { people, rejected } = extractPeople(html, "team");
    expect(people).toEqual([]);
    expect(rejected[0]?.reason).toContain("quotation");
  });

  it("deduplicates a person listed twice on one page", () => {
    const html =
      `<body><section><h3>Ada Lovelace</h3><p>Co-founder</p></section>` +
      `<section><h3>Ada Lovelace</h3><p>CTO</p></section></body>`;
    expect(extractPeople(html, "team").people).toHaveLength(1);
  });

  it("caps a directory-sized page and records what it dropped", () => {
    const rows = Array.from(
      { length: MAX_PEOPLE + 3 },
      (_, index) => `<div><h3>Ada Lovelace${"x".repeat(index + 1)}</h3><p>Engineer</p></div>`,
    ).join("");
    const { people, rejected } = extractPeople(`<body>${rows}</body>`, "team");
    expect(people).toHaveLength(MAX_PEOPLE);
    expect(rejected.every((entry) => entry.reason.includes(`more than ${MAX_PEOPLE}`))).toBe(true);
  });

  it("returns empty rather than throwing on markup that is not a page", () => {
    expect(extractPeople("", "team")).toEqual({ people: [], rejected: [], skipped: null });
    expect(() => extractPeople("<p", "home")).not.toThrow();
  });

  /**
   * The false positive this module structurally cannot see, pinned rather than
   * papered over — the same treatment `classifyHit` gives its own blind spot in
   * `src/source/hn.ts`.
   *
   * A customer quote under a "Our team" heading, with a job title and no
   * quotation marks around the endorsement, is indistinguishable from a staff
   * card by any rule available here. Two things bound the damage: the role is
   * carried verbatim ("VP Engineering, Northwind Freight" names another
   * company), and the LLM extractor in TICKET-0020 reads the same page text
   * with the context in front of it. It is a real gap and it is recorded in
   * STATE rather than claimed to be handled.
   */
  it("cannot tell an unquoted endorsement under a team heading from a colleague", () => {
    const html =
      `<body><section><h2>Our team</h2>` +
      `<div><h3>Dana Whitfield</h3><p>VP Engineering, Northwind Freight</p></div>` +
      `</section></body>`;
    const { people } = extractPeople(html, "home");
    expect(people.map((person) => person.name)).toEqual(["Dana Whitfield"]);
    expect(people[0]?.role).toContain("Northwind Freight");
  });
});
