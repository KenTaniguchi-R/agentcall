import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "apps/landing/index.html"), "utf8");

test("every inline landing-page script parses", () => {
  for (const [, source] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    assert.doesNotThrow(() => new Script(source));
  }
});

test("the landing page publishes favicon metadata and assets", () => {
  assert.match(
    html,
    /<link rel="icon" type="image\/svg\+xml" href="assets\/favicon\.svg">/,
  );
  assert.equal(existsSync(join(root, "apps/landing/assets/favicon.svg")), true);
});

test("every same-page fragment link has a landing target", () => {
  const targets = new Set(
    [...html.matchAll(/href="#([^"]+)"/g)].map(([, target]) => target),
  );
  const ids = new Set(
    [...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id),
  );
  const unresolved = [...targets].filter((target) => !ids.has(target));

  assert.deepEqual(unresolved, []);
});

// The landing page is the only AgentCall surface a stranger sees before
// installing, and it spent a release teaching `ken@acme.example.com` after the
// CLI, README, and docs site had all moved to `@acme/ken`. Nothing caught it:
// the checks above assert structure, not content, and the address is the
// product's core noun. The placeholder in the waitlist email field is a real
// email address and is deliberately exempt.
test("the landing page teaches the current @org/handle address format", () => {
  const withoutEmailPlaceholder = html.replace(/placeholder="[^"]*"/g, "");
  assert.doesNotMatch(
    withoutEmailPlaceholder,
    /[A-Za-z0-9_-]+@[A-Za-z0-9_-]+\.[A-Za-z]/,
    "landing page still shows a handle@host-style address; use @org/handle",
  );
  assert.match(html, /@acme\/ken/);
});

test("the waitlist posts to Formspark with accessible feedback", () => {
  assert.match(html, /<form[^>]+id="waitlist-form"/);
  assert.match(html, /action="https:\/\/submit-form\.com\/36DfpcI7U"/);
  assert.match(html, /<input[^>]+type="email"[^>]+required/);
  assert.match(html, /id="waitlist-status"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /name="_honeypot"/);
});

test("analytics records useful actions without form PII", () => {
  assert.match(html, /phc_yR9jbkhmKC39j3rSw2qvkLLLmPPmfvfNxHA7Rz5qNbfk/);
  assert.match(html, /cookieless_mode:\s*'always'/);
  assert.match(html, /autocapture:\s*false/);
  assert.match(html, /disable_session_recording:\s*true/);
  assert.match(html, /track\('cta_clicked'/);
  assert.match(html, /track\('waitlist_joined'\)/);
  assert.doesNotMatch(html, /track\([^\n]*(?:email|formData)/i);

  const success = html.indexOf("track('waitlist_joined')");
  const responseCheck = html.indexOf("if(!response.ok)");
  assert.ok(responseCheck !== -1 && success > responseCheck);
});
