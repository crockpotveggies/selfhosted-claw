# Slack Integration Setup

This integration is designed for a Slack app with **bot-user messaging enabled**.
It is not a generic Slack app integration and it does not use slash commands or shortcuts in v1.

A ready-to-import manifest for this integration lives in
[slack.app-manifest.json](C:/Users/justi/Projects/selfhosted-claw/src/integrations/slack.app-manifest.json).

## What This Integration Does

- Connects to Slack using **Socket Mode**
- Receives bot-visible message events from channels, private channels, and DMs
- Responds only when the bot is **@mentioned** in channels
- Responds normally in **DMs** without requiring a mention
- Replies back into the same **Slack thread** when a mention happened inside a thread

## Required Slack App Configuration

Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) and configure it as a bot-capable messaging app.
The fastest path is to create the app **from the manifest** in
[slack.app-manifest.json](C:/Users/justi/Projects/selfhosted-claw/src/integrations/slack.app-manifest.json),
then generate the app-level Socket Mode token afterward.

### 1. Enable a Bot User

Your Slack app must include a bot user.
This integration posts and receives messages as that bot identity.

### 2. Enable Socket Mode

Turn on **Socket Mode** for the app and generate an **App-Level Token** with the `connections:write` scope.

The manifest enables Socket Mode, but Slack still requires you to generate the
app-level token manually after the app exists.

Use that token as:

- `SLACK_APP_TOKEN=xapp-...`

### 3. Add Bot Token Scopes

Under **OAuth & Permissions**, add these bot token scopes:

- `app_mentions:read`
- `chat:write`
- `channels:history`
- `channels:read`
- `groups:history`
- `groups:read`
- `im:history`
- `im:read`
- `mpim:history`
- `mpim:read`
- `users:read`

After updating scopes, reinstall the app to the workspace.

Use the bot token as:

- `SLACK_BOT_TOKEN=xoxb-...`

### 4. Subscribe to Bot Events

Under **Event Subscriptions**, subscribe to bot events for:

- `app_mention`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

Socket Mode is the transport here, but event subscriptions still define what the bot receives.

## Conversation Behavior

- **Public channels:** the bot only responds when explicitly `@mentioned`
- **Private channels:** same behavior, but the bot must be invited first
- **DMs:** the bot responds without requiring a mention
- **Threads:** if the mention happened in a thread, the reply is posted back to that thread

## Important Slack-Specific Notes

- The bot only sees conversations it is allowed to access
- The bot must be invited to each channel or private channel it should monitor
- Mention gating is enforced by the Slack integration itself, not by the repo’s generic trigger regex
- v1 is **text-only**:
  no file uploads, block-kit interactivity, slash commands, shortcuts, or modals

## Setup in Self-Hosted Claw

Open the Slack integration page in the admin UI and provide:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

The setup flow validates both tokens before saving.
It then asks for the controller's Slack identity, which is written into the
shared Verified Identities list used by the Policy page.

Use a value like:

- `slack:user:U123ABC456`

Once saved, the integration page refreshes automatically so the status badge, credential state, and setup completion state all reflect the live Slack connection.

## Troubleshooting

### Bot connects but does not respond

- Make sure the app was reinstalled after adding scopes
- Confirm Socket Mode is enabled
- Confirm the bot was invited to the channel
- Confirm the message actually contains an `@mention`

### Bot works in DMs but not in channels

- Check `app_mentions:read`
- Check `message.channels` or `message.groups`
- Confirm the bot is a member of the conversation

### Setup validation fails

- `SLACK_BOT_TOKEN` should start with `xoxb-`
- `SLACK_APP_TOKEN` should start with `xapp-`
- App-level token must include `connections:write`
