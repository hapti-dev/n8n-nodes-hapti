# n8n-nodes-hapti

Hapti for [n8n](https://n8n.io): do tasks on websites that have no API. An agent uses a real browser by sight, like a person, and returns the result with proof. Tasks are billed only when they succeed.

Use it to book appointments, fill in and submit forms, download invoices and certificates, or check a status behind a login, on any website, from any n8n workflow or AI agent.

## Install

In n8n: **Settings**, **Community Nodes**, **Install**, then enter `n8n-nodes-hapti`.

## Credentials

Create a key on the developers screen of [app.hapti.dev](https://app.hapti.dev), then add a **Hapti API** credential in n8n and paste it. Test keys start with `hp_test_`: the agent works on the real site but never submits the data you give. Live keys start with `hp_live_`.

## Operations

| Operation | What it does |
| --- | --- |
| Run | Starts a task and waits until it ends, or until it needs someone (a question or an approval) |
| Start | Starts a task and returns at once, to follow it with Get or a webhook |
| Get | Reads the state and the result of a task |
| Answer | Gives the value a waiting task asked for |
| Approve or Refuse | Answers the approval a waiting task asked for |
| Cancel | Stops a task; a cancelled task is never billed |

A task needs a **Website URL** and a **Goal** in plain words, in any language. Options: **Files** (binary properties of the input item, such as an email attachment or an uploaded screenshot: the agent reads them to type the values they hold, and uploads them when the site asks for a file), **Data** (values the agent may use; it never invents a missing one), **Output Schema** (a JSON Schema the result follows, in `result.data`), **User** (the person the task is for: they keep their browser, sign-ins, inbox and vault from task to task), **Saved Accounts**, **Max Seconds**, **Max Price**, **Residential Proxy**, **Locale** and **Webhook URL**.

The node can also be used as a tool by the n8n AI Agent.

## Watch a website: Monitor and Hapti Trigger

The **Monitor** resource checks a website on a schedule and keeps only what changed: new listings, prices that moved, slots that opened, a file status.

| Operation | What it does |
| --- | --- |
| Watch a Website | Creates a monitor: a **Website URL**, **What to Read** in plain words, and **Every** (`30m`, `1h`, `1d`) or a cron rule. Give an **Output Schema** with a list and an **Item Key** such as `url` |
| Get Current Value | The last value read on the website, as if it had an API |
| Get Changes | What was added, removed or changed at each check, newest first |
| Get Many | Every monitor with its last check and last change |
| Delete | Stops a monitor and deletes its history |

The **Hapti Trigger** node starts a workflow once for each change a monitor finds, with `added`, `removed` and `changed`. Give it a monitor ID, or leave it empty to follow every monitor. Each check is a task, billed only when it succeeds. See [Monitors](https://hapti.dev/docs/monitors).

## Example

Run, with:

- Website URL: `https://www.service-public.fr`
- Goal: `Find the price of the tax stamp for an adult passport.`

returns the task with `status: "succeeded"` and the answer in `result.answer`.

## Links

- [Hapti documentation](https://hapti.dev/docs/)
- [Tasks: statuses, questions, results](https://hapti.dev/docs/tasks)
- [Pricing](https://hapti.dev/docs/pricing)

## License

MIT
