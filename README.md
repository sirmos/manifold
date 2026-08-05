# Manifold

Manifold is an operations agent for industrial sites. It was built for the All Things Agentic Hackathon, under the Fortified Enterprise Fleet track.

It watches data coming in from a plant or facility, checks it against normal ranges, works out why something looks wrong, and tells the right person on Telegram, WhatsApp, or email. Nobody has to ask it a question first. It runs on its own, in the background.

The name comes from the oil and gas term "manifold": a piece of equipment that takes several flow lines and merges them into one. That is what this project does with data. It takes scattered readings, logs, and reports and turns them into one clear message.

## The problem this solves

Sites like LNG plants, oil and gas fields, and factories collect a lot of data every day: SCADA exports, spreadsheets, maintenance records, shift notes, and more. Very little of that data is connected. Staff spend hours pulling it together by hand, and by the time a report reaches a manager, the situation on the ground has often already moved on.

This project follows one example from start to finish, so it is easy to test and easy to judge: a compressor at an LNG site starts running below its normal efficiency, and Manifold catches it, checks why, and tells the engineer, without anyone asking it to.

## What is built for this submission

- **Data Collection Agent.** Reads new data from CSV exports, spreadsheets, or a photo of a field logbook page. Cleans it up, checks the units, and saves it to Firestore.
- **Operations Monitoring Agent.** Compares each new reading to normal ranges built from past data. Flags anything that looks off.
- **Root Cause Investigation Agent.** Looks through maintenance history and past incidents in Firestore, then asks Gemini to rank the most likely causes.
- **Reporting and Notification Agent.** Writes a short, plain summary with Gemini and sends it out on Telegram, WhatsApp, or email. Also updates a status page linked to a QR code.

See `ARCHITECTURE.md` for the full picture, and `architecture.svg` for the diagram.

## What is planned but not built yet

These are part of the full Manifold plan but are left for later, on purpose, so this submission stays focused and working:

- **Forecasting Agent**, to estimate what an issue will cost in lost production if it is not fixed.
- **Coordination Agent**, to open a task, assign it to a team, and follow up until it is closed.
- **Compliance Agent**, to check a response against company rules and safety steps.
- **Agent Registry**, a shared catalog of agents across an organization, with versions.

## Tech stack

| Requirement | Tool used | Where |
|---|---|---|
| Gemini 3.5 | Vertex AI | reasoning, log reading, writing summaries |
| Google agent framework | Google ADK | defines each agent and how they pass messages |
| Google Cloud infrastructure | Cloud Run, Pub/Sub, Firestore, Cloud Scheduler | running agents, passing events, storing memory, timed checks |
| Notifications | Telegram Bot API, WhatsApp Business Cloud API, Gmail API | sending messages out |

## Project structure

```
manifold/
  agents/
    collector/          Data Collection Agent
    monitor/             Operations Monitoring Agent
    investigator/         Root Cause Investigation Agent
    reporter/             Reporting and Notification Agent
  common/                shared code: Firestore models, Pub/Sub helpers, Gemini client
  data/                  sample CSVs, sample logbook photos, sample maintenance records
  qr/                    QR code generation and the status page
  architecture.svg        architecture diagram
  ARCHITECTURE.md         written explanation of the diagram
  README.md               this file
```

## Setting it up

You will need:

- A Google Cloud project with billing set up (the hackathon gives you Google Cloud credits, see the Resources tab)
- The `gcloud` CLI installed and logged in
- Node.js 20 or newer (or Python 3.11 or newer, pick one and stay consistent across agents)
- A Telegram bot token (from BotFather, this takes about two minutes)

Steps:

1. Clone this repo and move into it.
   ```
   git clone <your repo url>
   cd manifold
   ```
2. Set your project.
   ```
   gcloud config set project YOUR_PROJECT_ID
   ```
3. Turn on the services this project needs.
   ```
   gcloud services enable run.googleapis.com pubsub.googleapis.com firestore.googleapis.com aiplatform.googleapis.com cloudscheduler.googleapis.com
   ```
4. Create the Firestore database (native mode, one per project).
   ```
   gcloud firestore databases create --location=YOUR_REGION
   ```
5. Create the Pub/Sub topics that agents use to talk to each other.
   ```
   gcloud pubsub topics create new-reading
   gcloud pubsub topics create anomaly-detected
   gcloud pubsub topics create findings-ready
   ```
6. Copy the example environment file and fill in your own values.
   ```
   cp .env.example .env
   ```
   Fields to fill in: `GCP_PROJECT_ID`, `GCP_REGION`, `TELEGRAM_BOT_TOKEN`, and, if you are also wiring up WhatsApp and email, `WHATSAPP_TOKEN` and `GMAIL_CREDENTIALS`.
7. Install dependencies inside each agent folder.
   ```
   cd agents/collector && npm install && cd ../..
   cd agents/monitor && npm install && cd ../..
   cd agents/investigator && npm install && cd ../..
   cd agents/reporter && npm install && cd ../..
   ```

## Running it locally

Each agent can run on its own machine first, before it goes to Cloud Run, so you can test the flow without paying for anything.

```
cd agents/collector && npm run dev
cd agents/monitor && npm run dev
cd agents/investigator && npm run dev
cd agents/reporter && npm run dev
```

Then send a sample file through the pipeline:

```
node scripts/send_sample.js data/sample_compressor_reading.csv
```

You should see the Collection Agent pick it up, the Monitoring Agent flag it if it is out of range, the Investigation Agent look through the sample maintenance record, and the Reporting Agent send a message to your Telegram bot.

## Deploying to Google Cloud

Each agent deploys as its own Cloud Run service, so a slow or failing agent does not take down the others.

```
gcloud run deploy manifold-collector --source=agents/collector --region=YOUR_REGION --no-allow-unauthenticated
gcloud run deploy manifold-monitor --source=agents/monitor --region=YOUR_REGION --no-allow-unauthenticated
gcloud run deploy manifold-investigator --source=agents/investigator --region=YOUR_REGION --no-allow-unauthenticated
gcloud run deploy manifold-reporter --source=agents/reporter --region=YOUR_REGION --no-allow-unauthenticated
```

Wire each Pub/Sub topic to the Cloud Run service that should read it with a push subscription:

```
gcloud pubsub subscriptions create new-reading-sub --topic=new-reading --push-endpoint=<collector-url>/pubsub
gcloud pubsub subscriptions create anomaly-sub --topic=anomaly-detected --push-endpoint=<investigator-url>/pubsub
gcloud pubsub subscriptions create findings-sub --topic=findings-ready --push-endpoint=<reporter-url>/pubsub
```

## Setting up notifications

**Telegram** (fastest to set up, good for the demo):
1. Message @BotFather on Telegram, run `/newbot`, and copy the token it gives you into `TELEGRAM_BOT_TOKEN`.
2. Start a chat with your new bot and send it any message once, so it can reply to your chat ID.

**WhatsApp**, using the WhatsApp Business Cloud API:
1. Create a Meta developer account and a WhatsApp Business app.
2. Copy the temporary access token and phone number ID into your `.env` file.
3. Note that Meta's test numbers only message a short list of approved numbers until the app is reviewed, which is worth knowing before demo day.

**Email**, using the Gmail API:
1. Turn on the Gmail API in your Google Cloud project.
2. Create an OAuth client and download the credentials file.
3. Run the one-time authorization script in `scripts/gmail_auth.js` to save a refresh token.

## QR code

Each monitored asset gets its own QR code, generated from a URL like `https://<reporter-url>/status/<asset-id>`. Print it and place it near the equipment. Scanning it opens a small page showing the asset's current status and last report, and gives the option to subscribe that phone number to Telegram or WhatsApp alerts for that one asset.

Generate one for the sample compressor with:

```
node scripts/generate_qr.js compressor-01
```

This writes a PNG to `qr/compressor-01.png`.

## About this project

This was built for the All Things Agentic Hackathon, Fortified Enterprise Fleet track. The scenario used throughout, a compressor running below normal efficiency at an LNG site, is based on a job posting for a Data Analyst role on an LNG project, and this project was also built as a working example of those same skills: collecting messy data, cleaning it, spotting trends, and turning it into a report someone can act on.
