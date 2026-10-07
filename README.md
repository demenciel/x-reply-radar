# x-reply-radar

A tiny Cloudflare Worker for Alexworks (@technoSaas). It watches up to 20 hand-picked X accounts, judges new original posts, drafts three short replies in your voice, and emails you through Resend. You select Funny, Engaging or Thought-provoking, open the prefilled X reply composer, review, and press Reply yourself. **The Worker never posts to X.**

## Architecture

```text
Cloudflare cron, every minute
  → enabled? → active hours? → interval elapsed?
  → atomic D1 lease
  → one TwitterAPI.io multi-author search (bounded pagination)
  → timestamp baseline + tweet-ID deduplication → durable pending tweets
  → cheap relevance filter → one LLM fit-and-drafts call (one repair if invalid)
  → save drafts and email payload → Resend with tweet-based idempotency
  → record accepted email and counter
```

Direct `fetch()` calls, TypeScript, no runtime npm dependencies, SDKs, dashboard or frontend. The OpenAI-compatible provider adapter is confined to `generator.ts`. All normal runtime settings are parsed once into a typed object in `config.ts`; keys are accessed only at the relevant integration boundary.

**Why D1 instead of KV:** reliable overlapping cron/manual execution requires atomic acquisition and fenced writes. [Workers KV is eventually consistent](https://developers.cloudflare.com/kv/concepts/how-kv-works/), so a KV read/write lock cannot provide that protection. D1 is materially better here: one small database stores state, retry records, deduplication and counters. No second storage service is needed. [D1 batches are transactional](https://developers.cloudflare.com/d1/worker-api/d1-database/).

## Quick setup and deployment

This repository's database and Worker are already provisioned. Use **Finish the existing deployment** below for the remaining credentials and activation; the quick setup commands in this section are for a fresh installation.

Prerequisites: Node.js 22.12 or newer, a Cloudflare account with Workers and D1, a TwitterAPI.io key, a Resend key and verified sending domain, and an OpenAI-compatible model key.

From the project directory:

```sh
npm install
npm run typecheck
npm test
npm run build
npx wrangler login
npx wrangler d1 create x-reply-radar
```

Copy the returned `database_id` into `wrangler.toml`, replacing the all-zero placeholder. Keep binding `DB` and `database_name = "x-reply-radar"`. Edit the initial `WATCHED_ACCOUNTS` JSON array in `[vars]`, and your initial provider settings if needed. Then:

```sh
npx wrangler d1 migrations apply x-reply-radar --remote
npx wrangler secret put TWITTERAPI_IO_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put LLM_API_KEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put EMAIL_FROM
npx wrangler secret put EMAIL_TO
npx wrangler deploy
```

Wrangler prompts for each secret. Use a random ADMIN_TOKEN at least 32 characters long; you can generate one with `openssl rand -hex 32`. EMAIL_FROM is a verified sender such as `X Reply Radar <radar@yourdomain.com>`; EMAIL_TO is one recipient address. Addresses are stored as secrets for privacy, though they are not API credentials.

`secret put` may create a placeholder Worker if this is its first deployment; the final `deploy` publishes this code. Do not commit keys or `.dev.vars`. The repository contains examples only.

Wrangler prints your URL, for example `https://x-reply-radar.YOUR-SUBDOMAIN.workers.dev`. Cron setup can take several minutes to propagate; [Cloudflare documents cron propagation](https://developers.cloudflare.com/workers/configuration/cron-triggers/). First successful discovery is a baseline and sends no historical alerts. No production deployment or paid live API request is performed by the project tests.

The lockfile pins the verified development toolchain; use `npm ci` for subsequent installs. `.npmrc` avoids an npm 11 optional-peer resolver crash. The `sharp` override pins the patched image library used internally by local Cloudflare tooling; it is not bundled in the Worker.

## Finish the existing deployment

The Worker is deployed at `https://x-reply-radar.alexcouture97.workers.dev` with its one-minute cron attached, D1 migrations are applied, and both GitHub's account-ID secret and database-ID variable are configured. ADMIN_TOKEN is configured in Cloudflare; its private local copy is in the ignored `.dev.vars` file with permissions 0600. Live checks verified authenticated `/health` and `/status`, unauthorized rejection, and `/poll` returning `disabled` without provider calls. The Worker is paused with an empty watched-account list while provider credentials are missing.

If a future deployment hits the account's cron-trigger limit, free an unused cron slot under **Workers & Pages → existing Worker → Settings → Triggers → Cron Triggers → ⋯ → Delete**, or raise the account limit. Removing a cron stops that Worker's scheduled runs. The current deployment successfully attached x-reply-radar's cron after a slot was freed.

Run from the project directory. Each secret command prompts privately; do not put literal keys in shell commands or paste them into chat.

```sh
npm run prepare:deploy
npx wrangler secret put TWITTERAPI_IO_KEY --config .wrangler.deploy.toml
npx wrangler secret put RESEND_API_KEY --config .wrangler.deploy.toml
npx wrangler secret put LLM_API_KEY --config .wrangler.deploy.toml
npx wrangler secret put EMAIL_FROM --config .wrangler.deploy.toml
npx wrangler secret put EMAIL_TO --config .wrangler.deploy.toml
gh secret set CLOUDFLARE_API_TOKEN --repo demenciel/x-reply-radar
```

EMAIL_FROM must use a verified Resend sending domain; EMAIL_TO is your recipient address. For the GitHub secret, create a Cloudflare API token scoped to this account with **Workers Editor** on x-reply-radar and **D1 Edit** for its database. GitHub's permanent CI token is separate from local Wrangler OAuth credentials. Existing account/database IDs and ADMIN_TOKEN need no additional setup.

Configure your actual hand-picked accounts, keeping polling paused for a test:

```sh
# Replace these example usernames with your watched accounts.
RADAR_ACCOUNTS='["levelsio","another_builder"]'
npx wrangler deploy --config .wrangler.deploy.toml \
  --var "WATCHED_ACCOUNTS:$RADAR_ACCOUNTS" \
  --var X_REPLY_RADAR_ENABLED:false

# This file contains the private admin token created during setup.
source .dev.vars
RADAR_URL='https://x-reply-radar.alexcouture97.workers.dev'
curl -sS "$RADAR_URL/health" -H "Authorization: Bearer $ADMIN_TOKEN"
curl -sS "$RADAR_URL/status" -H "Authorization: Bearer $ADMIN_TOKEN"
```

Use the `/test/tweet` example below with your actual numeric tweet ID and original text to verify generation and one email while still paused. Then enable polling and verify the GitHub deployment workflow:

```sh
npx wrangler deploy --config .wrangler.deploy.toml --var X_REPLY_RADAR_ENABLED:true
gh workflow run cloudflare.yml --repo demenciel/x-reply-radar --ref main
```

Active hours are already configured as 07:00–23:00 America/Moncton, with a two-minute effective poll interval and model `gpt-luna-6`. A first successful poll establishes a baseline; it does not send historical alerts. The CI deploy preserves runtime settings and Worker secrets.

## Automatic GitHub → Cloudflare deployments

[The deployment workflow](.github/workflows/cloudflare.yml) runs typecheck, all tests and a deployment dry run on pull requests and pushes to `main`. After checks pass, a push to `main` applies pending D1 migrations and deploys that exact commit, including the one-minute cron. Pull requests run checks only. You can also run it manually under **GitHub → Actions → Check and deploy Cloudflare Worker → Run workflow**, selecting `main`.

Deployment uses the lockfile's Wrangler directly and pinned official checkout/setup-node actions. Production runs are serialized without interrupting a migration/deployment in progress. An old queued commit is skipped if a newer `main` commit exists. A failed check or migration prevents publishing the new Worker code. Make migrations compatible with the currently deployed code: the schema update happens before the Worker update, and a later deployment failure does not roll back successful migrations.

### One-time repository configuration

In [GitHub Settings → Secrets and variables → Actions](https://github.com/demenciel/x-reply-radar/settings/secrets/actions), configure:

| Kind | Name | Value |
|---|---|---|
| Secret | CLOUDFLARE_API_TOKEN | Cloudflare CI API token scoped to the target account |
| Secret | CLOUDFLARE_ACCOUNT_ID | Target account ID; already configured for this repository |
| Variable | CLOUDFLARE_D1_DATABASE_ID | UUID of the D1 database dedicated to x-reply-radar |

[Cloudflare's GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) explains API-token authentication. The token needs Workers deployment access and **D1 Edit** to apply migrations. For a first deployment that creates the Worker, use Workers **Admin** at the Workers product scope; after it exists you can restrict the token to Workers **Editor** on x-reply-radar, retaining the D1 permission needed for migrations. Scope access to the intended account. See [Workers permissions](https://developers.cloudflare.com/workers/authorization/) for the current token roles.

Create a dedicated database with `npx wrangler d1 create x-reply-radar`, then save its UUID as `CLOUDFLARE_D1_DATABASE_ID`. The repository variable overrides `database_id` for CI; local development continues to use the source configuration. Alternatively, commit a real database ID in `wrangler.toml` and omit the repository variable. Missing credentials or a placeholder/invalid database ID stop deployment with a clear error before any migration or upload.

The dedicated x-reply-radar database is provisioned with UUID `fabc7d2b-32ca-40f1-b535-54e471666408`, and its GitHub repository variable is configured. If you deploy this project to another Cloudflare account, create a dedicated database there and update the binding and repository variable. The workflow does not delete or repurpose other applications' databases.

The API token must be entered privately in GitHub Secrets. The local Wrangler OAuth login cannot be used as a permanent CI token. The Worker API keys and ADMIN_TOKEN remain **Cloudflare Worker secrets**, configured with the existing `wrangler secret put` commands or the Cloudflare dashboard; they do not need to be copied to GitHub.

### Runtime settings remain controlled by Cloudflare

`npm run prepare:deploy` produces an ignored `.wrangler.deploy.toml` beside the source config. It injects the production database UUID, preserves `keep_vars = true`, and omits `[vars]` from the CI upload. This matters because explicitly uploaded variable values can override dashboard values even with `keep_vars` enabled. The original `wrangler.toml` stays unchanged for local development and manual initial setup.

As a result, code, bindings, migrations, cron and other Wrangler deployment settings reflect the repository. Watched accounts, operating hours, enabled/paused state, polling interval, model/provider settings and secrets retain their Cloudflare values across CI deployments. To change those runtime settings, use **Workers & Pages → x-reply-radar → Settings → Variables and Secrets**. If you change `LLM_MODEL` there, that value takes priority over the `gpt-luna-6` application fallback.

On the first **CI** deployment, set the runtime variables in Cloudflare, especially WATCHED_ACCOUNTS. Without that variable the application defaults to an empty list and performs no provider calls. Set X_REPLY_RADAR_ENABLED=false while entering the required API keys and email configuration, then test `/test/tweet`, inspect `/status`, and enable polling. The initial defaults table below is supplied by a manual deployment using `wrangler.toml`; CI deliberately leaves runtime-variable ownership with Cloudflare.

Once the token and database ID are configured, rerun the failed deploy job or use **Run workflow**. Deployment results and the exact commit appear in the Actions run summary. Avoid connecting a second independent deployment pipeline to the same Worker; this workflow is the deployment source for this repository.

## Provider setup

### TwitterAPI.io

Create/top up your account at [TwitterAPI.io](https://twitterapi.io/), get the key from its dashboard, and store it as `TWITTERAPI_IO_KEY`. This does not require X posting credentials. The only X-data endpoint used is:

```text
GET https://api.twitterapi.io/twitter/tweet/advanced_search
X-API-Key: <secret>
queryType=Latest
query=(from:account1 OR from:account2) -filter:replies -filter:retweets since_time:<seconds> until_time:<seconds>
cursor=<saved cursor or empty>
```

The [current endpoint contract](https://docs.twitterapi.io/api-reference/endpoint/tweet_advanced_search) specifies Unix-second boundaries, `Latest`, and cursor pagination, with about 20 results per page. [The provider describes advanced-search operators](https://twitterapi.io/blog/twitter-advanced-search-guide), including author filters and boolean combinations. We combine watched authors, then re-check author, timestamp, reply and retweet fields locally; quote posts pass. Vendor data is normalized into `Tweet` in `twitter.ts`.

This is the cheapest practical REST polling design for a small hand-picked list: ordinarily one request per eligible poll, instead of one per account. Per-user timelines remain useful for diagnosing a missing account, but are not an automatic fallback because that multiplies costs. Search depends on X/provider indexing: the configured interval plus indexing and generation latency determines when the email arrives. This is not a guaranteed real-time feed; webhook/stream alternatives are outside this cron-based MVP.

### Resend

Create a key at [Resend](https://resend.com/), verify your sender domain, and configure EMAIL_FROM and EMAIL_TO. Resend test senders may restrict recipients to your account email. Keep the API key in a Worker secret. Email delivery includes both HTML and plain text; successful API acceptance is counted, not inbox delivery.

### LLM

Set `LLM_API_KEY` as a secret, and `LLM_BASE_URL` / `LLM_MODEL` as normal variables. The base URL is the API prefix, **without** `/chat/completions`; the Worker appends that path. It must use HTTPS without embedded credentials, query parameters or fragments.

| Provider | LLM_BASE_URL | LLM_MODEL |
|---|---|---|
| OpenAI (initial default) | `https://api.openai.com/v1` | `gpt-luna-6` |
| xAI | `https://api.x.ai/v1` | A currently available chat model on your account |
| OpenRouter | `https://openrouter.ai/api/v1` | Your chosen provider/model slug |

The model must support Chat Completions with `response_format: {"type":"json_object"}`, temperature and `max_tokens`. Compatibility varies by model; choose one that supports these parameters. Switching the three provider settings does not require a source change. Fit and replies are generated together, so skipped posts never incur a separate drafting call. Strict local validation checks schema, distinct drafts, length, sentence capitalization, emoji, hashtags, generic praise and common invented experience claims; nuanced voice and factual accuracy still require your final review. Edit `prompt.ts` if you intentionally change your voice.

## Change runtime behavior in Cloudflare

Go to **Workers & Pages → x-reply-radar → Settings → Variables and Secrets**. Add/edit a normal **Variable** for each non-secret setting below, then save/apply the new configuration (use Deploy if the dashboard requests it). Changes apply to subsequent Worker invocations; an already-running invocation keeps its starting configuration. No application-code edit is required.

Keep the real Cron Trigger at `* * * * *`. Runtime variables control effective polling, not the actual cron schedule. [Cloudflare cron configuration](https://developers.cloudflare.com/workers/configuration/cron-triggers/) is separate from variables. If the base cron runs every 5 minutes, an interval of 1 minute cannot make it poll faster than those invocations.

The GitHub workflow preserves dashboard-configured variables by combining `keep_vars = true` with an upload config that omits `[vars]`. [Wrangler documents variable preservation](https://developers.cloudflare.com/workers/wrangler/configuration/). A manual `wrangler deploy` using the source config explicitly supplies `[vars]` and can override matching dashboard settings. For later manual code deployments that should preserve your runtime settings, set the real database UUID, run `npm run prepare:deploy`, then `npx wrangler deploy --config .wrangler.deploy.toml`. Review `/status` after deployment or dashboard changes.

### Normal Variables

| Variable | Default | Validation / purpose |
|---|---|---|
| X_REPLY_RADAR_ENABLED | `true` | Exactly `true` or `false` |
| ACTIVE_HOURS_ENABLED | `true` | Exactly `true` or `false` |
| ACTIVE_HOURS_START | `07:00` | Zero-padded 24-hour HH:MM; inclusive |
| ACTIVE_HOURS_END | `23:00` | HH:MM; exclusive; must differ from start |
| ACTIVE_TIMEZONE | `America/Moncton` | Valid IANA timezone; DST handled by Intl |
| POLL_INTERVAL_MINUTES | `2` | Integer 1–60; invalid values stop paid work |
| WATCHED_ACCOUNTS | `["levelsio"]` | JSON string array; maximum 20 entries; usernames with optional @ |
| SEND_SKIP_EMAILS | `false` | Optional informational mail with no drafts for skipped posts |
| LLM_BASE_URL | `https://api.openai.com/v1` | HTTPS OpenAI-compatible API prefix |
| LLM_MODEL | `gpt-luna-6` | Model name supported by your provider |
| MAX_TWEETS_PER_POLL | `5` | Integer 1–20; includes persisted retries |
| MAX_SEARCH_PAGES_PER_POLL | `3` | Integer 1–5; ordinarily only one page needed |
| MAX_DAILY_TWITTER_CALLS | `1000` | Integer 1–10000 |
| MAX_DAILY_LLM_CALLS | `100` | Integer 1–1000; includes repair calls |
| MAX_DAILY_EMAILS | `50` | Integer 1–500; caps send attempts, including retries |

Missing values use defaults; malformed values are rejected rather than silently becoming more aggressive. An empty watched list performs no paid work. Equal start/end is rejected; use `ACTIVE_HOURS_ENABLED=false` for 24/7 operation.

### Secrets

| Secret | Purpose |
|---|---|
| TWITTERAPI_IO_KEY | Read-only TwitterAPI.io requests |
| RESEND_API_KEY | Send alerts |
| LLM_API_KEY | Model requests |
| ADMIN_TOKEN | Bearer authentication for all manual endpoints; ≥32 characters |
| EMAIL_FROM | Verified sender address/display name |
| EMAIL_TO | Single recipient email address |

Never put keys in normal Variables, `wrangler.toml`, source files, commands with literal credentials, or logs. `/status` shows no keys or email addresses.

### Operating examples

| Mode | X_REPLY_RADAR_ENABLED | ACTIVE_HOURS_ENABLED | Start–end | Timezone | POLL_INTERVAL_MINUTES |
|---|---|---|---|---|---|
| Normal | `true` | `true` | `07:00`–`23:00` | America/Moncton | `2` |
| Aggressive | `true` | `false` | Ignored | America/Moncton | `1` |
| Cheap | `true` | `true` | `08:00`–`22:00` | America/Moncton | `5` |
| Paused | `false` | Either | Any valid window | America/Moncton | Any valid interval |
| Overnight | `true` | `true` | `18:00`–`02:00` | America/Moncton | `2` |

Disabled scheduled executions parse only the switch, emit one concise event, and do no database or external API work. Inactive executions validate config and check local time before any database/API access. Interval-skipped executions read state but make no paid API requests. The interval uses persisted `lastSuccessfulPollAt`, with a separate `lastAttemptPollAt` cooldown after failures; it never uses clock-minute modulo. Delayed invocations do not trigger catch-up polling bursts.

## Add or remove accounts

Before deployment, edit `WATCHED_ACCOUNTS` in `wrangler.toml`. Afterwards, change that **Variable** in the Cloudflare dashboard:

```json
["levelsio", "another_builder", "third_account"]
```

Use actual public usernames, no URLs. Capitalization and optional `@` are normalized, duplicates removed, and invalid usernames or more than 20 entries rejected. Newly added accounts receive their own baseline on the next successful search, even if no tweets are returned. Posts published before that baseline do not alert. Removed accounts stop being queried and their unsent queued tweets are suppressed. Re-adding an account after a successful poll without it establishes a new baseline. Previously sent or attempted tweet IDs remain protected from duplicate email.

## Local development

```sh
cp .env.example .dev.vars
# Edit .dev.vars privately with your keys, addresses and ADMIN_TOKEN.
npx wrangler d1 migrations apply x-reply-radar --local
npx wrangler dev --test-scheduled
```

`.env.example` intentionally sets the local radar switch to false and disables local active hours. `/test/tweet` still works. Enable the switch in `.dev.vars` to exercise local polling. Wrangler reads `.dev.vars`; `.env.example` alone is not loaded. Local D1 is separate from remote D1. Local manual endpoints use real providers and can send real email if you supply real keys. Automated tests mock every paid provider call and use isolated local D1.

In another terminal, set the base URL and privately read the admin token:

```sh
RADAR_URL='http://localhost:8787'
read -r -s RADAR_ADMIN_TOKEN
# Paste ADMIN_TOKEN at the prompt and press Enter.
curl -sS "$RADAR_URL/health" -H "Authorization: Bearer $RADAR_ADMIN_TOKEN"
curl -sS "$RADAR_URL/status" -H "Authorization: Bearer $RADAR_ADMIN_TOKEN"
```

Local scheduled-handler testing uses `curl -sS 'http://localhost:8787/__scheduled?cron=*+*+*+*+*'` when dev runs with `--test-scheduled`.

## Send one test alert

Set `RADAR_URL` to your deployed Worker URL or localhost, and read `RADAR_ADMIN_TOKEN` as above. This executes fit, generation, saving and email, bypassing global pause and active hours. It does not fetch the tweet from TwitterAPI.io.

```sh
curl -sS -X POST "$RADAR_URL/test/tweet" \
  -H "Authorization: Bearer $RADAR_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"tweetId":"YOUR_ACTUAL_NUMERIC_TWEET_ID","username":"ACTUAL_AUTHOR","text":"The actual post text about AI, building software or distribution."}'
```

Replace all three values with an existing X post. A fake numeric ID tests email delivery but its reply link will target a nonexistent post. Use a relevant post if you want an email; fit=skip is suppressed by default. The response reports saved `status`, validated `result`, a safe `errorCode`, and `nextAttemptAt` after retryable failures. Expected success is `status: "emailed"`. Repeating the same ID does not send another email or regenerate drafts; use a different actual tweet ID for a fresh test. Test and live alerts share the tweet-ID idempotency scope.

Tap a reply button on your actual mobile/browser setup and confirm both the original target and text before pressing Reply. Links use `https://x.com/intent/tweet?in_reply_to=<id>&text=<encoded draft>` with `URLSearchParams`; all three drafts also appear as plain copy-paste text. X/mobile apps and privacy tools can handle intent links differently, so device-level prefill behavior needs that live check.

## Manual polling and status

```sh
curl -sS -X POST "$RADAR_URL/poll" -H "Authorization: Bearer $RADAR_ADMIN_TOKEN"
curl -sS -X POST "$RADAR_URL/poll?force=true" -H "Authorization: Bearer $RADAR_ADMIN_TOKEN"
curl -sS "$RADAR_URL/status" -H "Authorization: Bearer $RADAR_ADMIN_TOKEN"
npx wrangler tail
```

All four routes, including `/health`, require Bearer ADMIN_TOKEN. `/poll` obeys pause, active hours and interval. `force=true` bypasses **only pause**, still respecting hours, interval, lease, budgets and deduplication. `/test/tweet` bypasses pause/hours/interval but respects the global lease, budgets and deduplication. An active lock returns 409 for a manual test; retry later. GET routes reject POST and vice versa.

`/status` reports enabled state, active-hours settings and whether currently active, interval, initialization time, last successful/attempt poll times, next eligible poll time, watched count, skip behavior, UTC daily counters, request limits, workflow counts and whether a search cursor is pending. `nextEligiblePollAt` is an estimate incorporating interval, failure cooldown and active hours; cron delays, budgets and locks can delay actual work. It is null when paused or no accounts are configured.

## Baseline, pagination and retry behavior

* First successful poll queries a bounded recent window, records the returned existing original tweet IDs as `baseline`, and saves a timestamp cutoff for **every** watched account. It sends no old alerts. The cutoff also suppresses historical IDs not returned on the first page.
* Incremental searches overlap by five minutes to catch delayed indexing. Timestamp cutoffs plus ID deduplication prevent replay alerts. Search lookback and saved scan lifetime are capped at one hour: after long pauses/outages, older history is deliberately skipped and `poll_gap_clamped` is logged. There is no historical backfill. After an inactive period, posts within the most recent hour may be eligible; older overnight posts are omitted.
* Each page checkpoints its cursor and fixed time window. A page limit saves a cursor for later polls rather than advancing past unread pages. The tweet processing cap leaves extra records queued. At excessive volume a scan older than one hour is abandoned to bound costs; this utility is intended for a small, low-volume list.
* State progresses `seen → generated → sending → emailed`; `baseline`, `skipped`, `failed` and `uncertain` are terminal. `emailed` means Resend accepted the request. Durable discovery defines a successful poll; a failed generation/email remains independently retryable in the queue on subsequent eligible polls. A Twitter failure does not advance the successful timestamp and postpones queue work until discovery succeeds.
* Generation has at most three workflow attempts. Each allows one initial call and one repair call for malformed/schema/voice-invalid output. Network/HTTP failures defer to a later poll. Email has at most three attempts. Retry delays are exponential (2, 4, then 8 minutes); exact execution also depends on your polling interval and active hours. Unsent queued work expires after 24 hours.
* Before the first email call, save the exact payload, first-attempt time and permanent compact receipt. Every retry uses `Idempotency-Key: x-reply-radar/<tweetId>` and the identical saved payload, even if email settings change. [Resend retains idempotency keys for 24 hours](https://resend.com/changelog/idempotency-keys). Automatic email retries stop after **23 hours**, leaving a margin, or when attempts are exhausted; ambiguous results become `uncertain` and are never resent with a fresh key. This conservatively favors avoiding duplicates over recovering every uncertain delivery.
* The 90-second atomic lease is renewed before paid calls; calls have a 25-second timeout. Fenced database writes prevent a stale owner from changing state after another owner acquires the lease. Resend idempotency protects mail if execution dies between send and persistence. A crashed lease expires automatically; no manual reset is normally necessary.
* Raw posts, drafts, payloads and terminal records are pruned after 30 days on eligible polls. Small email receipt records retain only tweet ID, first-attempt time and optional Resend ID permanently, so repeating a manual test cannot resend after payload cleanup. Daily counter rows retain 30 days. This is a deliberate exception to short record retention for duplicate safety; no growing raw-post archive is kept.

## API behavior and costs

Current [TwitterAPI.io pricing](https://twitterapi.io/pricing), checked October 7, 2026: $0.15 per 1,000 returned tweets, with a $0.00015 minimum per call, including empty results. Repeated overlap results are also billable. One combined search minimizes that empty-call floor; account-specific queries would multiply it.

Approximate 30-day **empty-result search floors**, assuming one page per eligible poll and no failures:

| Mode | Eligible polls/day | Search floor/month |
|---|---:|---:|
| Normal: 16 hours, every 2 minutes | 480 | $2.16 |
| Aggressive: 24 hours, every minute | 1,440 | $6.48 |
| Cheap: 14 hours, every 5 minutes | 168 | $0.76 |

These are arithmetic estimates, not total bills. Returned tweets, overlap, pagination and retries increase costs; LLM tokens, Resend and Cloudflare usage are additional and depend on your plans. The default Twitter cap is 1,000/day, so **Aggressive needs MAX_DAILY_TWITTER_CALLS at least 1440**, preferably 2000 for pagination, to operate the full day. Choose caps deliberately; Twitter daily call count is not a dollar cap because each page can return multiple tweets.

Counters reserve requests before calling providers, so they conservatively include attempted/failed calls and a reservation abandoned by a crash. UTC midnight resets budgets; timezone settings control operating hours only. LLM repair counts toward the LLM cap; email retries count toward MAX_DAILY_EMAILS. Budget exhaustion postpones the affected work until UTC midnight, subject to queue age and the email idempotency cutoff. Forced/manual calls cannot bypass caps.

Normal operation makes zero Twitter, LLM or email requests on disabled, inactive or interval-skipped cron invocations. Those cron invocations still count as Cloudflare Worker executions. Check your Cloudflare plan's Workers/D1 quotas; D1 has no per-minute writes while paused/inactive. Keep paid-provider spending limits in their dashboards where available.

## Troubleshooting

| Symptom | Check |
|---|---|
| 401 | Bearer token must match the ADMIN_TOKEN secret and have at least 32 characters; no spaces/newlines |
| Configuration error / 503 | `/status` names the invalid field; strict true/false, interval 1–60, valid timezone, distinct HH:MM start/end, valid JSON accounts |
| No alerts on first poll | Expected baseline behavior; use `/test/tweet` to test email |
| `disabled`, `inactive`, `interval_not_elapsed` | Inspect `/status`; `force=true` bypasses pause only |
| `no_accounts` | Populate WATCHED_ACCOUNTS with a JSON array of public usernames |
| `locked` | Let the current workflow finish; abandoned leases expire after 90 seconds |
| Missing DB table / zero placeholder ID | Apply migrations to the right local/remote database and replace database_id |
| Twitter HTTP 401/403/429 | Verify key, credit balance and provider limits; no automatic per-user request storm occurs |
| Missing watched posts | Confirm public username, original/quote rather than reply/repost, account baseline, one-hour lookback, provider indexing and cursor backlog |
| LLM HTTP 400 | Confirm model supports JSON-object mode, temperature and max_tokens; base URL excludes /chat/completions |
| `llm_invalid_after_repair` | Provider twice violated strict output/voice; inspect provider behavior privately; next eligible retry is bounded |
| Resend error | Verify domain, sender, key and allowed recipient; check Resend dashboard |
| `uncertain` | Check Resend dashboard before any human action; do not delete state or issue a new key to blindly resend |
| Daily limit reached | Counters and caps are in `/status`; raise a cap intentionally or wait until UTC midnight |
| Prefill missing on mobile | Open the original-post link, tap Reply and use the copy-paste fallback; verify target before submitting |
| Local tests cannot start | Workers test runtime needs localhost listeners; allow them in your execution environment |

Logs are concise structured JSON with event, stage, success and, for tweet processing, tweetId, username and durationMs. Provider response bodies, tweet text, generated drafts, tokens and addresses are never logged. `/health` checks config and a database read; it does not probe or prove provider credentials.

## Development checks and directory tree

```sh
npm run typecheck
npm test
npm run test:deploy
npm run build
npm audit
```

Tests run in Cloudflare's local Workers runtime with real D1 SQL and migrations, mocked paid providers, and no production secrets. They cover gates, IANA/DST/overnight windows, persisted cadence, auth, atomic locks and fencing, baselines/account additions, pagination, reply/repost exclusion, quotes, URL encoding, HTML escaping, malformed generation repair, skips, retries, daily caps, and email uncertainty/retention.

```text
x-reply-radar/
├── .github/
│   └── workflows/
│       └── cloudflare.yml
├── .env.example
├── .gitignore
├── .npmrc
├── README.md
├── migrations/
│   └── 0001_init.sql
├── package.json
├── package-lock.json
├── tsconfig.json
├── vitest.config.ts
├── wrangler.toml
├── scripts/
│   └── prepare-deploy.mjs
├── src/
│   ├── config.ts
│   ├── email.ts
│   ├── filter.ts
│   ├── generator.ts
│   ├── http.ts
│   ├── index.ts
│   ├── intent.ts
│   ├── log.ts
│   ├── pipeline.ts
│   ├── poll.ts
│   ├── prompt.ts
│   ├── store.ts
│   ├── twitter.ts
│   └── types.ts
└── test/
    ├── config.test.ts
    ├── deploy-config.test.mjs
    ├── setup.ts
    └── worker.test.ts
```

`node_modules`, `.wrangler` and `dist` are generated and excluded from source control and the delivery archive. API contracts and prices can change; consult the linked provider docs if integration behavior changes.
