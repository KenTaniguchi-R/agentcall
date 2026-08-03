# Free analytics and waitlist stack for the landing page

**Date:** 2026-08-03
**Status:** Research note, not a product decision.
**Method:** Exa was used to discover candidate pricing and documentation pages. All
claims below were checked against first-party vendor documentation on 2026-08-03.
**Target:** A dependency-free static HTML site on GitHub Pages, with useful traffic
analytics and an email waitlist at no recurring cost for the initial launch.

**Implementation decision:** The initial recommendation was Umami Cloud, but its
dashboard and API returned TLS protocol errors across independent networks during
setup. The shipped implementation therefore uses the documented runner-up,
PostHog Cloud, with cookieless mode, autocapture, and session recording disabled.

---

## Recommendation

Use **Umami Cloud Hobby + Formspark Free**.

- **Umami** adds one script tag, supports a `waitlist_joined` custom event, uses no
  cookies or cross-site tracking, exports cloud data, and has an MIT-licensed
  self-hosted escape hatch. Its Hobby plan is completely free and intended for
  low-traffic sites. Umami's accessible official documentation does **not** publish
  the current Hobby event allowance, so do not promise a numeric limit
  ([Cloud FAQ](https://docs.umami.is/docs/cloud/faq),
  [collection](https://docs.umami.is/docs/collect-data),
  [events](https://docs.umami.is/docs/track-events),
  [export](https://docs.umami.is/docs/cloud/export-data),
  [license](https://github.com/umami-software/umami)).
- **Formspark** keeps the site's existing native `<form>` and styling. It needs only
  an `action` URL, explicitly requires no credit card, automatically filters spam,
  supports Turnstile/hCaptcha/reCAPTCHA, and exports CSV or JSON on the free plan.
  The exact constraint is **250 submissions total per workspace**, not per month;
  after that, the current upgrade is a one-time purchase rather than a subscription
  ([pricing](https://formspark.io/pricing/),
  [static HTML setup](https://formspark.io/),
  [spam protection](https://documentation.formspark.io/setup/spam-protection.html),
  [exports](https://formspark.io/features/exports/)).

Track `waitlist_joined` **only after Formspark returns success**, not on button click.
Never send the email address or other form values to Umami. This measures completed
signups while keeping contact data solely in the form backend.

If 250 total signups is too small, use **Tally Free** instead. It offers unlimited
forms and submissions under its fair-use policy, free reCAPTCHA, CSV export, and a
submission event that can trigger Umami. The tradeoff is a Tally iframe/script and
visible Tally branding; removing branding or applying custom CSS requires Pro
([pricing](https://tally.so/pricing),
[embedding](https://tally.so/help/embed-your-form),
[events](https://developers.tally.so/widgets/events),
[reCAPTCHA](https://tally.so/help/recaptcha),
[CSV export](https://tally.so/changelog)).

---

## Analytics comparison

| Option | Free fit | Conversion tracking | Privacy and consent burden | Exportability / lock-in | Verdict |
|---|---|---|---|---|---|
| **Umami Cloud** | Hobby is free; official docs do not expose its current numeric event cap | Native custom events from an HTML attribute or `umami.track()` | No cookies, no PII, no cross-site tracking; vendor says GDPR compliant out of the box | CSV export of pageviews, events, sessions and event data; MIT self-hosting on PostgreSQL | **Best fit:** small snippet, enough conversion tracking, lowest practical lock-in ([FAQ](https://docs.umami.is/docs/faq), [events](https://docs.umami.is/docs/track-events), [export](https://docs.umami.is/docs/cloud/export-data)) |
| **PostHog Cloud** | 1 million analytics events/month, no card, one-year retention; usage can be capped at the free allowance | Richest option: explicit events, autocapture and funnels | More configuration: it can create persistent anonymous profiles and collect browser/location data; the customer controls consent and collection | API/SQL access and MIT self-hosting, but no equivalently simple full cloud-history export | Excellent runner-up if the landing page soon becomes a product funnel ([pricing](https://posthog.com/pricing), [HTML install](https://posthog.com/docs/web-analytics/installation), [events](https://posthog.com/docs/product-analytics/capture-events), [privacy](https://posthog.com/docs/privacy)) |
| **Cloudflare Web Analytics** | Free; one script and no Cloudflare proxying required | No custom events or UTM parameters; only a success-page view can approximate a signup | No visitor PII and no cross-site tracking | Six months in the dashboard; no documented raw Web Analytics export | Privacy-friendly but fails the conversion-tracking requirement ([overview](https://developers.cloudflare.com/web-analytics/about/), [FAQ](https://developers.cloudflare.com/web-analytics/faq/), [collection](https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/)) |
| **Google Analytics 4** | Standard GA is free | Strong custom events and key events; BigQuery export available | Uses first-party `_ga` cookies by default; Consent Mode/CMP work creates the highest burden, especially for EEA traffic or Ads linkage | Strong raw BigQuery export, but more setup and Google ecosystem coupling | Capable, but unnecessarily heavy for this launch ([events](https://support.google.com/analytics/answer/9322688), [signup events](https://support.google.com/analytics/answer/14144294), [cookies](https://support.google.com/analytics/answer/11397207), [BigQuery](https://support.google.com/analytics/answer/9823238)) |
| **Plausible Cloud** | Only a 30-day no-card trial; ongoing cloud use is paid | Strong custom events and goals | Cookieless and no personal data; vendor says no cookie banner is needed | Aggregate CSV export; raw event export is Enterprise-only; self-hosting is available but adds operational cost | Not free-for-now unless self-hosted ([plans](https://plausible.io/docs/subscription-plans), [features](https://plausible.io/docs/your-plausible-experience), [data access](https://plausible.io/docs/data-access), [privacy](https://plausible.io/docs)) |

### Analytics constraint to watch

Umami counts every page hit, custom event, and stored event-data property toward
usage. Emit one success event with no properties unless a non-personal property is
actually useful. The free plan's unpublished cap is the only material uncertainty;
PostHog is the fallback if traffic reaches it
([Umami usage definition](https://docs.umami.is/docs/cloud/faq)).

---

## Waitlist and form comparison

| Option | Free allowance and card | Static-site / spam fit | Portability and privacy | Verdict |
|---|---|---|---|---|
| **Formspark** | **250 total** free submissions in the first workspace; no card; 10 forms | Native custom HTML; no JS required. Automatic filtering plus free Turnstile, hCaptcha, reCAPTCHA and honeypot options | CSV/JSON export on every plan; vendor advertises no lock-in. A form endpoint remains vendor-specific but is trivial to replace | **Recommended:** best match for the existing dependency-free design; 250-total ceiling is explicit ([pricing](https://formspark.io/pricing/), [spam](https://documentation.formspark.io/setup/spam-protection.html), [export](https://documentation.formspark.io/dashboard/exporting-submissions.html)) |
| **Tally** | Unlimited forms/submissions under fair-use; no time limit | Free iframe/script embed and reCAPTCHA; `Tally.FormSubmitted` supports success-only analytics | CSV export and EU storage; Tally branding and iframe remain on Free, custom CSS/removal require Pro | Best high-volume free fallback; weaker visual and dependency fit ([pricing](https://tally.so/help/plans-and-pricing), [embed](https://tally.so/help/embed-your-form), [GDPR](https://tally.so/help/gdpr)) |
| **Buttondown** | First 100 subscribers free; official pricing does not state a card requirement | Native stylable HTML endpoint for static/JAMstack sites; optional double opt-in and firewall/CAPTCHA protections | Subscriber exports are CSV/JSON; it stores a real mailing list and can send launch email | Best if "waitlist" must immediately be a newsletter, but 100 contacts is a small ceiling ([pricing](https://buttondown.com/pricing), [HTML embed](https://docs.buttondown.com/building-your-subscriber-base), [exports](https://docs.buttondown.com/api-exports-list), [firewall](https://docs.buttondown.com/firewall)) |
| **Google Forms** | Free for personal Google accounts; practically high response capacity | Hosted/iframe form, not the site's native styled input; no documented configurable public-form CAPTCHA | Direct Google Sheets destination and CSV/Takeout export; substantial Google UI/ecosystem lock-in | Reliable storage, poor landing-page experience and awkward success-event instrumentation ([product](https://www.google.com/intx/en/forms/about/), [responses](https://support.google.com/docs/answer/139706?hl=en-GB), [sharing/embed](https://support.google.com/a/users/answer/9299716?hl=en)) |
| **Web3Forms** | 250 submissions/month and unlimited forms on Free; official pages do not state a card requirement | Native HTML/AJAX; server-side filtering and free hCaptcha. Turnstile/reCAPTCHA/domain restriction are paid | Primarily forwards to email; its FAQ says submissions are not retained, while another official page says Free stores them for 30 days. This contradiction makes export/recovery unclear | Easy but not a good system of record for a waitlist; US-East processing and two-month PII log deletion add privacy considerations ([limits](https://web3forms.com/alternatives/formspree-alternative), [HTML](https://docs.web3forms.com/how-to-guides/html-and-javascript), [spam/privacy FAQ](https://docs.web3forms.com/getting-started/faq), [storage claim](https://web3forms.com/platforms/html-contact-form)) |
| **Formspree** | 50 submissions/month; 30-day history on Free | Native HTML endpoint; reCAPTCHA and honeypot on all plans | CSV/JSON export is **paid only**, so Free has poor portability | Familiar but strictly worse than Formspark for this launch ([limits](https://help.formspree.io/articles/account-management/account-limits/), [HTML](https://formspree.io/html/), [spam](https://help.formspree.io/articles/building-your-form/honeypot-spam-filtering/), [export](https://help.formspree.io/articles/form-and-project-settings/exporting-submissions/)) |
| **Basin** | 50 submissions/month, one endpoint, 30-day retention on Free | Native HTML/AJAX; basic filtering and free CAPTCHA integrations; spam does not count | Data export begins on Starter, not Free; Free may stop accepting after its monthly cap | Good defenses, but Free is too constrained and non-portable ([pricing](https://usebasin.com/pricing), [plan comparison](https://docs.usebasin.com/plan-comparison/), [FAQ](https://docs.usebasin.com/faq/)) |

### Why not combine analytics and the form provider?

Formspark's built-in form analytics counts submissions and country without a tracking
pixel or cookie, but it cannot replace site-level acquisition, pageview, referrer and
conversion-rate measurement. Umami answers those questions; Formspark remains the
source of truth for the actual email list
([Formspark analytics](https://formspark.io/features/analytics/)).

---

## Implementation boundary

The initial implementation should contain only:

1. Umami's generated tracker `<script>` in `<head>`.
2. The existing email form pointed at the generated Formspark endpoint.
3. AJAX submission so the page can show an inline success state and call
   `umami.track('waitlist_joined')` only after a successful response.
4. Formspark's automatic filtering plus Cloudflare Turnstile if spam appears; avoid a
   visible CAPTCHA until evidence justifies its conversion cost.
5. A short privacy line explaining that the email is used for launch updates, with a
   link to the site's privacy notice. Analytics receives no email or user identifier.

The endpoint and Umami website ID are public client-side identifiers, not secrets.
Store them in the static page or build configuration; do not introduce GitHub Actions
secrets merely to hide values that every browser must receive.
