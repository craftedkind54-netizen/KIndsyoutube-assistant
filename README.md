# KindCrafted Creator Manager

A private YouTube management dashboard for @KindCrafted-m4q.

## Included
- Finds private videos and queues them oldest-first.
- Schedules up to 2 publishing slots per day.
- Learns candidate posting hours from historical upload performance.
- Uses Gemini to classify comments.
- Automatically replies to normal comments in a friendly/positive style.
- Sends questions to the web dashboard for manual review.
- Uses Google OAuth for channel authorization.
- Requires `CRAFTED-MANAGER-VERIFY-2026` in the channel description before automation runs.

## Setup
1. Upload this project to GitHub.
2. Create a Google Cloud project and enable **YouTube Data API v3**.
3. Configure the OAuth consent screen.
4. Create a **Web application** OAuth client.
5. Deploy the GitHub repo to Railway (or another Node host).
6. Set `BASE_URL` to the public deployment URL.
7. In the Google OAuth client, add: `https://YOUR-DOMAIN/oauth2callback` as an authorized redirect URI.
8. Copy every variable from `.env.example` into the host's environment variables. Never commit the real secrets.
9. Create a Gemini API key in Google AI Studio and put it in `GEMINI_API_KEY`.
10. Put `CRAFTED-MANAGER-VERIFY-2026` in your YouTube channel description.
11. Open the dashboard and click **Connect YouTube**. Sign into the Google account that owns the channel and approve the requested YouTube permissions.

## Important behavior
The app checks every 10 minutes. Private, processed videos without an existing `publishAt` time are scheduled oldest-first. YouTube itself performs the scheduled publication after `publishAt` is set.

The first version intentionally does **not** auto-like comments because the YouTube Data API does not provide a supported method for the channel owner to like viewer comments.

## Database persistence
The app uses `data/creator.db`. On Railway, attach a persistent volume and mount it so the `data` directory survives redeploys. Without persistent storage, OAuth tokens, question history, and duplicate-reply protection can be lost after a redeploy.

## Safety
Do not put `GOOGLE_CLIENT_SECRET`, `GEMINI_API_KEY`, or OAuth tokens in GitHub. Use deployment environment variables.
