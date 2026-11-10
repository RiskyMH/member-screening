# Member Screening

A small Discord bot that screens new members and quarantines suspicious accounts until they verify.

## `/join-guard`

Opens a modal to configure the screening:

- **Quarantine channel** — private verification threads are created here, and a message with an "Open verification thread" button is posted.
- **Quarantine role** — applied to members who fail screening. Configure this role to deny access to every channel except the quarantine channel.
- **Log channel** *(optional)* — where quarantine, verification, and kick events are logged, plus role/kick failures. Later events reply to the original quarantine log when possible.
- **Screening options** (all enabled by default):
  - **Recent accounts** — accounts created in the last 15 days.
  - **Spammer flags** — Discord's `Spammer`/`Quarantined` user flags or `unusual_dm_activity_until`.
  - **Default avatars** — no avatar, or one of Discord's default/mobile avatar hashes.
  - **No global name** — user has only a username and no display name.
- Verification time is fixed at **3 hours**.

## How quarantine works

1. A member joins and matches one or more enabled rules.
2. The bot gives them the quarantine role and creates a private thread in the quarantine channel.
3. The thread explains why they were quarantined and gives them a **Verify me** button.
4. Pressing it opens a short "I'm not a robot" modal. Submitting it removes the quarantine role, marks the quarantine as passed, logs it, and deletes the thread.
5. If the 6 hour timer expires first, the bot DMs them (best effort), kicks them, logs it, and deletes the thread.

## Setup

Requires [Bun](https://bun.com).

```sh
bun install
DISCORD_TOKEN=your_token_here bun run dev
```

Environment variables:

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token. |
| `DATABASE_URL` | no | SQLite database. Defaults to `sqlite://db.sqlite`. |

The **Server Members** privileged intent must be enabled in the Discord developer portal for `GuildMemberAdd`.
