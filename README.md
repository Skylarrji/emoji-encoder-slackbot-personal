# Emoji Encoder Slack Bot

A Slack bot that creates emoji-based data visualizations from CSV data.

## Features

- **Bar Charts**: Create bar charts with emoji bars
- **Single Value Charts**: Visualize data with low/medium/high emoji scales
- **Trend Charts**: Show trends over time with emoji indicators
- **Proportion Charts**: Display proportions with emoji representations
- **AI-Powered Emoji Recommendations**: Uses Python backend for intelligent emoji suggestions

## Setup

### Prerequisites

1. **Node.js** (v16 or higher)
2. **Python 3** (v3.8 or higher)
3. **Slack App** with appropriate permissions

### Installation

1. **Install Node.js dependencies:**

   ```bash
   npm install
   ```

2. **Install Python dependencies:**

   ```bash
   cd ../emoji-recommendation
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

3. **Set up environment variables:**
   Create a `.env` file in the root directory:

   ```
   SLACK_BOT_TOKEN=your_slack_bot_token
   SLACK_APP_TOKEN=your_slack_app_token
   ```

4. **Start the bot:**
   ```bash
   npm start
   ```

## Python Integration

The bot now integrates with the Python emoji recommendation system located in `../emoji-recommendation/`. This provides intelligent emoji suggestions based on:

- **Column names**: Context-aware emoji suggestions for data columns
- **Data values**: Emoji mappings for categorical values
- **Table context**: Overall table description influences recommendations

### How it works

1. When a user creates a chart, the bot parses their CSV data
2. The data is formatted for the Python backend (description row with n-1 commas where n is the number of columns)
3. The data is sent to the Python backend via the `generate_emojis.py` script
4. The Python system analyzes the data and returns emoji recommendations
5. The bot uses these recommendations to suggest appropriate emojis for charts

### Python Backend Features

- **Embedding-based matching**: Uses semantic embeddings to find relevant emojis
- **Context awareness**: Considers table description and column context
- **Categorical value mapping**: Maps specific data values to appropriate emojis
- **Scale generation**: Creates emoji scales for numeric data

## Usage

1. **Start the bot** in your Slack workspace
2. **Use the `/emojichart` command** to create a new chart
3. **Enter your data** in CSV format
4. **Choose chart type** (bar, single value, trend, or proportion)
5. **Select columns** for labels and values
6. **Customize emojis** using AI-powered suggestions
7. **Preview and post** your emoji chart

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

### Python Backend Issues

If emoji recommendations aren't working:

1. **Ensure virtual environment is set up:**

   ```bash
   cd ../emoji-recommendation
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

2. **Check Python installation:**

   ```bash
   python3 --version
   ```

3. **Verify dependencies:**

   ```bash
   cd ../emoji-recommendation
   pip list
   ```

4. **Test the Python script directly:**
   ```bash
   cd ../emoji-recommendation
   source .venv/bin/activate
   cd src
   python -m emoji_data.generate_emojis --input_csv ../data/movies.csv --output_json ../results/test.json --top_k 5
   ```

### Fallback Behavior

If the Python backend fails, the bot will fall back to simple keyword-based emoji suggestions.

## Development

### Adding New Chart Types

1. Create the chart generation function
2. Add the view handler for column selection
3. Update the emoji recommendation calls to use the new async function

### Modifying Emoji Recommendations

The Python backend can be customized by modifying the files in `../emoji-recommendation/src/`:

- `embedding/`: Embedding generation and matching
- `disambiguation/`: Word sense disambiguation
- `scale/`: Emoji scale generation
- `emoji_data/`: Main emoji recommendation logic
