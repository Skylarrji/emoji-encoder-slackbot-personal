# Emoji Encoder Slack Bot

A Slack bot that creates emoji-based data visualizations from CSV data.

## Charts Supported

- **Bar Charts**
- **Single Value Charts**
- **Trend Charts**
- **Proportion Charts**

## Setup

### Prerequisites

1. **Node.js** (v16 or higher)
2. **Python 3** (v3.8 or higher)
3. **Slack App** with appropriate permissions

### Installation

1. **Clone Repositories:**

   ```bash
   git clone https://github.com/ubixgroup/emoji-encoder-slackbot.git
   git clone https://github.com/ubixgroup/emoji-recommendation.git
   ```

2. **Install dependencies on Slackbot Frontend:**

   ```bash
   cd emoji-encoder-slackbot
   npm install
   ```

3. **Install dependencies on Python Backend:**

   ```bash
   cd ../emoji-recommendation
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

4. **Set up environment variables:**
   Create a `.env` file in the root `emoji-encoder-slackbot` directory and enter the following information

   ```
   SLACK_APP_TOKEN=your_slack_app_token
   SLACK_BOT_TOKEN=your_slack_bot_token
   ```

   To access the tokens:
   - Navigate to this URL: https://api.slack.com/apps

   - Click on **Emoji Encoder** under App Name
   - Go to **Basic Information** on the lefthand side
   - Click on the **Development** token under the App-Level Tokens section
   - Enter the token to replace the `your_slack_app_token` in the `.env` file
   - Go to **OAuth & Permissions** on the lefthand side
   - Enter the value under **Bot User OAuth Token** to replace `your_slack_bot_token` in the `.env` file

   #### Study configuration (optional)

   The following variables configure the bot for use as a controlled-study
   interface. They are optional; if omitted, the bot runs as the full semantic
   recommendation tool with study controls open to all users.

   | Variable                | Default    | Description                                                                                                                                                                                                                                                                                                                                                                            |
   | ----------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `STUDY_VARIANT`         | `semantic` | The interface condition to start in. One of `semantic` (full semantic recommendations), `manual` (no suggestions; the participant enters every emoji), or `placeholder` (a generic non-semantic symbol in every slot). Acts only as the default — once an experimenter runs `/setup`, the chosen condition overrides this without a restart.                                           |
   | `EXPERIMENTER_USER_IDS` | _(unset)_  | A comma- or space-separated list of the experimenters' Slack user IDs. When set, the `/setup` and `/check` commands are restricted to those accounts so participants cannot view or change the active condition. When unset, the commands are open to all users (dev mode) and a warning is shown. (The singular `EXPERIMENTER_USER_ID` is still accepted for backward compatibility.) |
   | `PLACEHOLDER_EMOJI`     | `⬛`       | The generic symbol used for every slot in the `placeholder` condition.                                                                                                                                                                                                                                                                                                                 |
   | `MANUAL_UNSET_EMOJI`    | `⬜`       | The neutral "unset" marker shown in the `manual` condition before the participant types their own emoji.                                                                                                                                                                                                                                                                               |
   | `EMOJI_API_URL`         | _(unset)_  | Base URL of the Python emoji-recommendation backend (the bot calls `${EMOJI_API_URL}/recommend`). Required only for the `semantic` condition.                                                                                                                                                                                                                                          |

   Example `.env` for running a session as the manual condition with the
   commands locked to the experimenter:

   ```
   SLACK_APP_TOKEN=your_slack_app_token
   SLACK_BOT_TOKEN=your_slack_bot_token
   EMOJI_API_URL=http://localhost:8000
   STUDY_VARIANT=manual
   EXPERIMENTER_USER_IDS=U0123456789,U0987654321
   ```

   To find your Slack user ID, open your profile in Slack, click the
   **⋯ (More)** menu, and choose **Copy member ID**.

   #### Running and switching conditions during a session

   The active condition can be set or changed at any time without restarting
   the bot, using the experimenter-only slash commands:
   - `/setup` — opens a modal to set the active participant ID and
     condition (and, optionally, the chart data type, dataset topic, task
     number, and Latin-square cell). The chosen condition takes effect
     immediately for the next chart.
   - `/check` — shows the current session context (participant,
     condition, and task metadata) as a private message.

5. **Start the bot:**

   ```bash
   cd ../emoji-encoder-slackbot
   npm run start
   ```

   You should see the following message in the console (if not, see the Troubleshooting section):

   ```
   > bolt-js-getting-started-app@2.0.0 start
   > node app.js

   ⚡️ Emoji Encoder is running!
   [study] Active interface variant: semantic
   ```

### How it works

1. When a user creates a chart, the bot parses their CSV data
2. The data is sent to the backend, which analyzes the data and returns emoji recommendations
3. The bot uses these recommendations to suggest appropriate emojis for charts

## Usage

1. Navigate to the Slack workspace in which the bot is installed
2. Use the `/emojichart` command to create a new chart
3. Enter your data in CSV format
4. Choose chart type (bar, single value, trend, or proportion)
5. Select columns for labels and values
6. Customize emojis using AI suggestions
7. Preview and post your emoji chart

## Example

```
/emojichart

Chart title: Movie Ratings by Genre
Data:
Genre,Rating
Action,8.5
Comedy,7.8
Drama,8.9
```

The bot will suggest appropriate emojis like 🎬 for movies, ⭐ for ratings, etc.

## Troubleshooting

### Slackbot Frontend Issues

If you are receiving the following message in the console, run the `/emojichart` command again on Slack and re-run the application using `npm run start`:

```
> bolt-js-getting-started-app@2.0.0 start
> node app.js

[WARN]  socket-mode:SlackWebSocket:1 A pong wasn't received from the server before the timeout of 5000ms!
```

### Python Backend Issues

If emoji recommendations aren't working:

1. **Ensure virtual environment is set up:**

   ```bash
   cd ../emoji-recommendation
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

2. **Test the Python script directly:**
   ```bash
   cd ../emoji-recommendation
   source .venv/bin/activate
   cd src
   python -m emoji_data.generate_emojis --input_csv ../data/movies.csv --output_json ../results/test.json --top_k 5
   ```
