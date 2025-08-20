import pkg, { ReceiverInconsistentStateError } from "@slack/bolt";
const { App } = pkg;
import stringWidth from "string-width";
import moment from "moment";
import "dotenv/config";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

app.command("/emojichart", async ({ command, ack, body, client }) => {
  await ack();

  const metadata = {
    channelId: command.channel_id,
    threadTs: command.thread_ts || null,
  };

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "emoji_chart_modal",
        private_metadata: JSON.stringify(metadata),
        title: { type: "plain_text", text: "Create Emoji Chart", emoji: true },
        submit: { type: "plain_text", text: "Next", emoji: true },
        close: { type: "plain_text", text: "Cancel", emoji: true },
        blocks: [
          {
            type: "input",
            block_id: "chart_title_block",
            label: { type: "plain_text", text: "Chart title", emoji: true },
            element: {
              type: "plain_text_input",
              action_id: "chart_title_input",
              placeholder: {
                type: "plain_text",
                text: "Transportation in different cities",
              },
            },
          },
          {
            type: "section",
            block_id: "upload_file_info",
            text: {
              type: "mrkdwn",
              text: "*Example table input:*\n```\nPopulation,Place,Bike Score\n614664,BWI,56\n```",
            },
          },
          {
            type: "input",
            block_id: "table_data_block",
            label: {
              type: "plain_text",
              text: "Paste table data here",
              emoji: true,
            },
            element: {
              type: "plain_text_input",
              multiline: true,
              action_id: "table_input",
              placeholder: {
                type: "plain_text",
                text: "e.g. Population,Place,Bike Score",
              },
            },
          },
          {
            type: "section",
            block_id: "insight_block",
            text: {
              type: "mrkdwn",
              text: "*What insight do you want to communicate?*",
            },
            accessory: {
              type: "radio_buttons",
              action_id: "insight_input",
              options: [
                {
                  text: { type: "plain_text", text: "Comparison" },
                  value: "comparison",
                },
                { text: { type: "plain_text", text: "Trend" }, value: "trend" },
                {
                  text: { type: "plain_text", text: "Proportion" },
                  value: "proportion",
                },
              ],
            },
          },
        ],
      },
    });
  } catch (error) {
    console.error(error);
  }
});

// Add action handler for insight selection
app.action("insight_input", async ({ body, ack, client }) => {
  await ack();
  const selected = body.actions[0].selected_option.value;
  // Copy current blocks except chart type block if present
  let blocks = body.view.blocks.filter(
    (b) => b.block_id !== "chart_type_block"
  );
  // If 'comparison' is selected, add chart type block
  if (selected === "comparison") {
    blocks.push({
      type: "section",
      block_id: "chart_type_block",
      text: {
        type: "mrkdwn",
        text: "*What type of chart do you want to visualize?*",
      },
      accessory: {
        type: "radio_buttons",
        action_id: "chart_type_input",
        options: [
          {
            text: { type: "plain_text", text: "Bar chart" },
            value: "bar_chart",
          },
          {
            text: { type: "plain_text", text: "Single value chart" },
            value: "single_value_chart",
          },
        ],
      },
    });
  }
  // Update the modal
  await client.views.update({
    view_id: body.view.id,
    hash: body.view.hash,
    view: {
      type: "modal",
      callback_id: body.view.callback_id,
      private_metadata: body.view.private_metadata,
      title: body.view.title,
      submit: body.view.submit,
      close: body.view.close,
      blocks,
    },
  });
});

const parseTableData = (rawTableData) => {
  const lines = rawTableData.trim().split("\n");
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = lines
    .slice(1)
    .map((line) => line.split(",").map((cell) => cell.trim()));
  return { headers, rows };
};

const getCategoricalColumns = (headers, rows) => {
  // Categorical: <=5 unique values, not all numeric
  return headers.filter((_, idx) => {
    const values = rows.map((row) => row[idx]);
    const unique = Array.from(new Set(values));
    const allNumeric = unique.every((v) => !isNaN(Number(v)));
    return unique.length <= 5 && !allNumeric;
  });
};

const getGeneralCategoricalColumns = (headers, rows) => {
  // General categorical: at least 1 unique value, not all numeric
  return headers.filter((_, idx) => {
    const values = rows.map((row) => row[idx]);
    const unique = Array.from(new Set(values));
    const allNumeric = unique.every((v) => !isNaN(Number(v)));
    return unique.length >= 1 && !allNumeric;
  });
};

const getQuantitativeColumns = (headers, rows) => {
  // Quantitative: all values numeric
  return headers.filter((_, idx) => {
    const values = rows.map((row) => row[idx]);
    return values.every((v) => v !== "" && !isNaN(Number(v)));
  });
};

const monthNames = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

const weekdayNames = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];

const knownDateFormats = [
  moment.ISO_8601,
  "YYYY-MM-DD",
  "YYYY/MM/DD",
  "MM-DD-YYYY",
  "MM/DD/YYYY",
  "DD-MM-YYYY",
  "DD/MM/YYYY",
  "MMM DD, YYYY",
  "MMMM DD, YYYY",
  "YYYY",
];

// detects the temporal type of a single value (supports date variations)
const getTemporalType = (value) => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const str = String(value).trim().toLowerCase();
  const num = Number(str);

  // full datetime or date
  for (const format of knownDateFormats) {
    const parsed = moment(str, format, true);
    if (parsed.isValid()) {
      if (format === "YYYY") return "yearStr";
      return format === moment.ISO_8601 ? "timestamp" : "date";
    }
  }

  // time units
  if (!isNaN(num)) {
    if (num >= 1900 && num <= 2100) return "yearInt";
    if (num >= 1 && num <= 12) return "monthInt";
    if (num >= 1 && num <= 31) return "dayOfMonth";
    if (num >= 0 && num <= 23) return "hour";
  }

  if (monthNames.includes(str)) return "monthStr";
  if (weekdayNames.includes(str)) return "dayOfWeek";

  return null;
};

export const getTemporalColumns = (headers, rows) => {
  return headers.flatMap((col, idx) => {
    const values = rows
      .map((row) => row[idx])
      .filter((v) => v !== "" && v !== null && v !== undefined);
    if (values.length === 0) return [];
    const types = values.map(getTemporalType);
    const uniqueTypes = Array.from(new Set(types.filter(Boolean)));
    if (uniqueTypes.length === 1) {
      return [col];
    }
    return [];
  });
};

// extra helper functions used for sorting the rows by temporal column when creating the trend chart
export const parseTemporalLabel = (value) => {
  const str = String(value).trim().toLowerCase();

  for (const format of knownDateFormats) {
    const parsed = moment(str, format, true);
    if (parsed.isValid()) return parsed;
  }

  const looseParsed = moment(str);
  if (looseParsed.isValid()) return looseParsed;

  const num = Number(str);
  if (!isNaN(num)) {
    if (num >= 1900 && num <= 2100) return moment(`${num}-01-01`);
    if (num >= 0 && num <= 23)
      return moment(`2000-01-01 ${num}:00`, "YYYY-MM-DD HH:mm");
    if (num >= 1 && num <= 31) return moment(`2000-01-${num}`, "YYYY-MM-DD");
  }

  if (monthNames.includes(str)) {
    const monthIndex = monthNames.indexOf(str) % 12;
    return moment().month(monthIndex).startOf("month");
  }

  if (weekdayNames.includes(str)) {
    const dayIndex = weekdayNames.indexOf(str) % 7;
    return moment().day(dayIndex);
  }

  return moment.invalid();
};

export const compareTemporalLabels = (a, b) => {
  const aMoment = parseTemporalLabel(a);
  const bMoment = parseTemporalLabel(b);
  return aMoment.valueOf() - bMoment.valueOf();
};

app.view("emoji_chart_modal", async ({ ack, view, body, client }) => {
  const rawTableData = view.state.values.table_data_block.table_input.value;
  const chartTitle =
    view.state.values.chart_title_block.chart_title_input.value;

  const insight =
    view.state.values.insight_block.insight_input.selected_option.value;

  const { headers, rows } = parseTableData(rawTableData);
  const hasCategorical = getCategoricalColumns(headers, rows).length > 0;
  const hasGeneralCategorical =
    getGeneralCategoricalColumns(headers, rows).length > 0;
  const numQuantitative = getQuantitativeColumns(headers, rows).length;
  const hasQuantitative = numQuantitative > 0;
  const hasTemporal = getTemporalColumns(headers, rows).length > 0;

  if (insight === "comparison" && (!hasCategorical || !hasQuantitative)) {
    await ack({
      response_action: "errors",
      errors: {
        table_data_block:
          "Your data must have at least one categorical column (with at most 5 unique values) and one numeric column.",
      },
    });
    return;
  }

  if (insight === "trend" && (!hasTemporal || !hasQuantitative)) {
    await ack({
      response_action: "errors",
      errors: {
        table_data_block:
          "Your data must have at least one temporal column and one numeric column.",
      },
    });
    return;
  }

  if (insight === "proportion" && !hasGeneralCategorical) {
    await ack({
      response_action: "errors",
      errors: {
        table_data_block:
          "Your data must have at least one general categorical column.",
      },
    });
    return;
  }

  let chartType = insight;

  if (insight === "comparison") {
    chartType =
      view.state.values.chart_type_block?.chart_type_input?.selected_option
        ?.value;
  }

  const oldMetadata = JSON.parse(view.private_metadata || "{}");
  const tableData = { headers, rows };

  // recommend emojis asynchronously
  // process.nextTick(async () => {
  //   try {
  //     await recommendEmojis("", tableData, chartTitle);
  //   } catch (err) {
  //     console.error("Error generating emoji recommendations:", err);
  //   }
  // });

  const private_metadata = JSON.stringify({
    ...oldMetadata,
    rawTableData,
    chartType,
    chartTitle,
  });

  if (chartType === "bar_chart") {
    // Only show the two questions for bar chart
    const categorical = getCategoricalColumns(headers, rows);
    const quantitative = getQuantitativeColumns(headers, rows);
    const catOptions = categorical.map((col) => ({
      text: { type: "plain_text", text: col },
      value: col,
    }));
    const quantOptions = quantitative.map((col) => ({
      text: { type: "plain_text", text: col },
      value: col,
    }));
    await ack({
      response_action: "push",
      view: {
        type: "modal",
        callback_id: "bar_chart_column_select",
        private_metadata: private_metadata,
        title: { type: "plain_text", text: "Chart Setup", emoji: true },
        submit: { type: "plain_text", text: "Next", emoji: true },
        close: { type: "plain_text", text: "Back", emoji: true },
        blocks: [
          {
            type: "input",
            block_id: "label_column_block",
            label: {
              type: "plain_text",
              text: "Which column should be used as the label?",
            },
            element: {
              type: "static_select",
              action_id: "label_column",
              options: catOptions,
            },
          },
          {
            type: "input",
            block_id: "value_column_block",
            label: {
              type: "plain_text",
              text: "Which numeric column should be visualized with emojis?",
            },
            element: {
              type: "static_select",
              action_id: "value_column",
              options: quantOptions,
            },
          },
        ],
      },
    });
    return;
  }

  if (chartType === "single_value_chart") {
    const categorical = getCategoricalColumns(headers, rows);
    const quantitative = getQuantitativeColumns(headers, rows);

    const catOptions = categorical.map((col) => ({
      text: { type: "plain_text", text: col },
      value: col,
    }));
    const quantOptions = quantitative.map((col) => ({
      text: { type: "plain_text", text: col },
      value: col,
    }));

    await ack({
      response_action: "push",
      view: {
        type: "modal",
        callback_id: "single_value_column_select",
        private_metadata,
        title: { type: "plain_text", text: "Chart Setup", emoji: true },
        submit: { type: "plain_text", text: "Next", emoji: true },
        close: { type: "plain_text", text: "Back", emoji: true },
        blocks: [
          {
            type: "input",
            block_id: "label_column_block",
            label: {
              type: "plain_text",
              text: "Which column should be used as the label?",
            },
            element: {
              type: "static_select",
              action_id: "label_column",
              options: catOptions,
            },
          },
          {
            type: "input",
            block_id: "value_column_block",
            label: {
              type: "plain_text",
              text: "Which numeric column should be visualized with emojis?",
            },
            element: {
              type: "static_select",
              action_id: "value_column",
              options: quantOptions,
            },
          },
          {
            type: "input",
            optional: true,
            block_id: "value_range_low_block",
            label: {
              type: "plain_text",
              text: "What is the lower bound of the numeric column?",
            },
            element: {
              type: "plain_text_input",
              action_id: "value_range_low_input",
              placeholder: {
                type: "plain_text",
                text: "e.g. 0",
              },
            },
          },
          {
            type: "input",
            optional: true,
            block_id: "value_range_high_block",
            label: {
              type: "plain_text",
              text: "What is the upper bound of the numeric column?",
            },
            element: {
              type: "plain_text_input",
              action_id: "value_range_high_input",
              placeholder: {
                type: "plain_text",
                text: "e.g. 100",
              },
            },
          },
        ],
      },
    });
    return;
  }

  if (insight === "trend") {
    const quantitative = getQuantitativeColumns(headers, rows);
    const temporal = getTemporalColumns(headers, rows);

    const quantOptions = quantitative.map((col) => ({
      text: { type: "plain_text", text: col },
      value: col,
    }));

    const temporalOptions = temporal.map((col) => ({
      text: { type: "plain_text", text: col },
      value: col,
    }));

    await ack({
      response_action: "push",
      view: {
        type: "modal",
        callback_id: "trend_chart_column_select",
        private_metadata,
        title: { type: "plain_text", text: "Chart Setup", emoji: true },
        submit: { type: "plain_text", text: "Next", emoji: true },
        close: { type: "plain_text", text: "Back", emoji: true },
        blocks: [
          {
            type: "input",
            block_id: "label_column_block",
            label: {
              type: "plain_text",
              text: "Which time column should be used as the label?",
            },
            element: {
              type: "static_select",
              action_id: "label_column",
              options: temporalOptions,
            },
          },
          {
            type: "input",
            block_id: "value_column_block",
            label: {
              type: "plain_text",
              text: "Which numeric column should be visualized as a trend?",
            },
            element: {
              type: "static_select",
              action_id: "value_column",
              options: quantOptions,
            },
          },
          {
            type: "input",
            optional: true,
            block_id: "value_range_low_block",
            label: {
              type: "plain_text",
              text: "What is the lower bound of the visualized numeric column?",
            },
            element: {
              type: "plain_text_input",
              action_id: "value_range_low_input",
              placeholder: {
                type: "plain_text",
                text: "e.g. 0",
              },
            },
          },
          {
            type: "input",
            optional: true,
            block_id: "value_range_high_block",
            label: {
              type: "plain_text",
              text: "What is the upper bound of the visualized numeric column?",
            },
            element: {
              type: "plain_text_input",
              action_id: "value_range_high_input",
              placeholder: {
                type: "plain_text",
                text: "e.g. 150",
              },
            },
          },
        ],
      },
    });
    return;
  }

  if (insight === "proportion") {
    const categorical = getGeneralCategoricalColumns(headers, rows);
    const quantitative = getQuantitativeColumns(headers, rows);
    const catOptions = categorical.map((col) => ({
      text: { type: "plain_text", text: col },
      value: col,
    }));

    const quantOptions = quantitative.map((col) => ({
      text: { type: "plain_text", text: col },
      value: col,
    }));

    const noneOption = {
      text: { type: "plain_text", text: "None" },
      value: "none",
    };

    await ack({
      response_action: "push",
      view: {
        type: "modal",
        callback_id: "proportion_chart_column_select",
        private_metadata: private_metadata,
        title: { type: "plain_text", text: "Chart Setup", emoji: true },
        submit: { type: "plain_text", text: "Next", emoji: true },
        close: { type: "plain_text", text: "Back", emoji: true },
        blocks: [
          {
            type: "input",
            block_id: "value_column_block",
            label: {
              type: "plain_text",
              text: "Which column should be visualized with emojis?",
            },
            element: {
              type: "static_select",
              action_id: "value_column",
              options: catOptions,
            },
          },
          {
            type: "input",
            block_id: "numeric_column_block",
            label: {
              type: "plain_text",
              text: "Which column should be used to determine frequency?",
            },
            element: {
              type: "static_select",
              action_id: "numeric_column",
              options:
                quantOptions.length > 0
                  ? [...quantOptions, noneOption]
                  : [noneOption],
            },
          },
          {
            type: "input",
            optional: true,
            block_id: "num_emojis_per_line_block",
            label: {
              type: "plain_text",
              text: "Number of emojis per line (default = 10)",
            },
            element: {
              type: "plain_text_input",
              action_id: "num_emojis_per_line_input",
              placeholder: {
                type: "plain_text",
                text: "e.g. 10",
              },
            },
            hint: {
              type: "plain_text",
              text: "This also sets the chart height (total emojis = n x n).",
            },
          },
        ],
      },
    });
    return;
  }

  // fallback option
  const options = headers.map((col) => ({
    text: { type: "plain_text", text: col },
    value: col.toLowerCase().replace(/ /g, "_"),
  }));
  await ack({
    response_action: "push",
    view: {
      type: "modal",
      callback_id: "emoji_chart_finalize",
      title: { type: "plain_text", text: "Create Emoji Chart", emoji: true },
      submit: { type: "plain_text", text: "Generate", emoji: true },
      close: { type: "plain_text", text: "Back", emoji: true },
      blocks: [
        {
          type: "input",
          block_id: "label_column_block",
          label: { type: "plain_text", text: "Label Columns" },
          element: {
            type: "multi_static_select",
            action_id: "label_columns",
            placeholder: { type: "plain_text", text: "Select 1 or more" },
            options,
          },
        },
        {
          type: "input",
          block_id: "value_column_block",
          label: { type: "plain_text", text: "Value Columns" },
          element: {
            type: "multi_static_select",
            action_id: "value_columns",
            placeholder: { type: "plain_text", text: "Select 1 or more" },
            options,
          },
        },
        {
          type: "input",
          optional: true,
          block_id: "group_by_block",
          label: { type: "plain_text", text: "Group by" },
          element: {
            type: "static_select",
            action_id: "group_by",
            placeholder: { type: "plain_text", text: "Select a column" },
            options,
          },
        },
      ],
    },
  });
});

// helper function to call the Python emoji recommendation script
async function callEmojiRecommendation(tableData, tableDescription) {
  try {
    // create a temporary CSV file with the table data
    const tempCsvPath = path.join(__dirname, "temp_table.csv");
    const tempJsonPath = path.join(__dirname, "temp_recommendations.json");

    // format the CSV data: first row is description (with commas to match column count), second row is headers, then data
    const numColumns = tableData.headers.length;
    const descriptionRow = tableDescription + ",".repeat(numColumns - 1);
    const csvContent = [
      descriptionRow,
      tableData.headers.join(","),
      ...tableData.rows.map((row) => row.join(",")),
    ].join("\n");

    await fs.writeFile(tempCsvPath, csvContent);

    const pythonModulePath = path.join(
      __dirname,
      "..",
      "emoji-recommendation",
      "src"
    );

    // check if virtual environment exists
    const venvPythonPath = path.join(
      __dirname,
      "..",
      "emoji-recommendation",
      ".venv",
      "bin",
      "python"
    );

    try {
      await fs.access(venvPythonPath);
    } catch (error) {
      throw new Error(
        `Virtual environment not found at ${venvPythonPath}. Please run:\n` +
          `cd ../emoji-recommendation\n` +
          `python3 -m venv .venv\n` +
          `source .venv/bin/activate\n` +
          `pip install -r requirements.txt`
      );
    }

    return new Promise((resolve, reject) => {
      const pythonProcess = spawn(
        venvPythonPath,
        [
          "-m",
          "emoji_data.generate_emojis",
          "--input_csv",
          tempCsvPath,
          "--output_json",
          tempJsonPath,
          "--top_k",
          "5",
        ],
        {
          cwd: pythonModulePath,
          stdio: ["pipe", "pipe", "pipe"],
        }
      );

      let stdout = "";
      let stderr = "";

      pythonProcess.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      pythonProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      pythonProcess.on("close", async (code) => {
        try {
          if (code === 0) {
            // read the generated JSON file
            const jsonContent = await fs.readFile(tempJsonPath, "utf8");
            const recommendations = JSON.parse(jsonContent);

            // clean up temporary files
            await fs.unlink(tempCsvPath);
            await fs.unlink(tempJsonPath);

            resolve(recommendations);
          } else {
            console.error("Python script failed:", stderr);
            reject(
              new Error(`Python script failed with code ${code}: ${stderr}`)
            );
          }
        } catch (error) {
          reject(error);
        }
      });
    });
  } catch (error) {
    console.error("Error calling emoji recommendation:", error);
    throw error;
  }
}

// cache for emoji recommendations to avoid repeated calls
const emojiRecommendationCache = new Map();

// enhanced emoji recommendation function that uses the Python backend
async function recommendEmojis(tableData = null, tableDescription = null) {
  // if we have table data and description, use the Python backend
  if (tableData && tableDescription) {
    const cacheKey = `${tableDescription}_${JSON.stringify(tableData)}`;

    if (emojiRecommendationCache.has(cacheKey)) {
      const cached = emojiRecommendationCache.get(cacheKey);
      return cached;
    }

    try {
      const recommendations = await callEmojiRecommendation(
        tableData,
        tableDescription
      );

      emojiRecommendationCache.set(cacheKey, recommendations); // cache the result
      return recommendations;
    } catch (error) {
      console.error(
        "Failed to get emoji recommendations from Python backend:",
        error
      );
    }
  }
}

function getRecEmojiOptions(recommendations, colName, type, value = null) {
  let emojis = [];

  if (type === "value") {
    emojis =
      recommendations?.categorical_value_emojis?.[colName]?.[value] || [];
    return emojis.map((e) => ({ emoji: e.trim() }));
  }

  if (type === "scale") {
    const scaleSets = recommendations?.column_emoji_scales?.[colName] || [];

    const lowSet = new Set();
    const mediumSet = new Set();
    const highSet = new Set();

    scaleSets.forEach((set) => {
      if (set[0]) lowSet.add(set[0].trim());
      if (set[1]) mediumSet.add(set[1].trim());
      if (set[2]) highSet.add(set[2].trim());
    });

    return {
      low: [...lowSet].map((e) => ({ emoji: e })),
      medium: [...mediumSet].map((e) => ({ emoji: e })),
      high: [...highSet].map((e) => ({ emoji: e })),
    };
  }

  if (type === "column_name") {
    emojis = recommendations?.column_name_emojis?.[colName] || [];
    return emojis.map((e) => ({ emoji: e.trim() }));
  }

  return [];
}

/// BAR CHART ///
function generateBarChartPreview({
  agg,
  labelEmoji,
  valueEmoji,
  showLabelEmoji,
  showLegend,
  valueCol,
  legendLabel,
  chartTitle,
  showTitle = true,
  maxEmojis = 10, // max emojis for the bar length
  showEmojiAtEnd = false, // if true, the value emoji will only be shown at the end
}) {
  const sorted = Object.entries(agg).sort((a, b) => b[1] - a[1]);
  const maxValue = sorted[0]?.[1] || 1; // find max value to calculate the ratio

  // compute the widest label for alignment
  const maxLabelWidth = Math.max(
    ...sorted.map(([label]) => {
      const labelPart =
        showLabelEmoji && labelEmoji ? `${labelEmoji} ${label}` : label;
      return stringWidth(labelPart);
    })
  );

  let preview = sorted
    .map(([label, val]) => {
      const labelPart =
        showLabelEmoji && labelEmoji ? `${labelEmoji} ${label}` : label;
      const paddingNeeded = maxLabelWidth - stringWidth(labelPart);
      const paddedLabel = labelPart + " ".repeat(paddingNeeded);

      // scale the bar length proportionally
      const ratio = val / maxValue;
      const emojiCount = Math.max(1, Math.round(ratio * maxEmojis));

      let bar;
      if (showEmojiAtEnd) {
        // show the braille space character for placeholder and one emoji at the end
        bar = "⠀⠀".repeat(emojiCount - 1) + valueEmoji;
      } else {
        bar = valueEmoji.repeat(emojiCount);
      }

      return `${paddedLabel}  ${bar}`;
    })
    .join("\n");

  if (showLegend && valueEmoji) {
    preview += `\n\nLegend: ${valueEmoji} = ${legendLabel || valueCol}`;
  }
  if (showTitle && chartTitle) {
    preview = `${chartTitle}\n\n${preview}`;
  }
  return preview;
}

// add action handlers for live preview updates in bar_chart_emoji_customize
const barChartEmojiActions = [
  "label_emoji",
  "value_emoji",
  "show_legend",
  "show_title_checkbox",
  "show_end_emoji_checkbox",
];
barChartEmojiActions.forEach((actionId) => {
  app.action(actionId, async ({ body, ack, client }) => {
    await ack();
    const view = body.view;
    const state = view?.state?.values || {};
    // Get current selections
    const labelEmoji =
      state.label_emoji_block?.label_emoji?.selected_option?.value || "";

    const valueEmoji =
      state.value_emoji_block?.value_emoji?.selected_option?.value || "";

    const showLegend =
      state.show_legend_block?.show_legend?.selected_options?.some(
        (opt) => opt.value === "show"
      ) || false;

    const showTitle =
      state.show_title_block?.show_title_checkbox?.selected_options?.some(
        (opt) => opt.value === "show"
      ) ?? true;

    const showEmojiAtEnd =
      state.show_end_emoji_block?.show_end_emoji_checkbox?.selected_options?.some(
        (opt) => opt.value === "show"
      ) || false;

    const private_metadata = JSON.parse(view.private_metadata || "{}");
    const rawTableData = private_metadata.rawTableData;
    const labelCol = private_metadata.labelCol;
    const valueCol = private_metadata.valueCol;
    const chartTitle = private_metadata.chartTitle;
    // Parse data
    const lines = rawTableData.trim().split("\n");
    const headers = lines[0].split(",").map((h) => h.trim());
    const rows = lines
      .slice(1)
      .map((line) => line.split(",").map((cell) => cell.trim()));
    const labelIdx = headers.indexOf(labelCol);
    const valueIdx = headers.indexOf(valueCol);
    const agg = {};
    rows.forEach((row) => {
      const label = row[labelIdx];
      const value = Number(row[valueIdx]);
      agg[label] = (agg[label] || 0) + value;
    });
    const legendLabel = valueCol;

    const preview = generateBarChartPreview({
      agg,
      labelEmoji: labelEmoji,
      valueEmoji: valueEmoji,
      showLabelEmoji: !(labelEmoji === "none"),
      showLegend: showLegend,
      valueCol: valueCol,
      legendLabel: legendLabel,
      chartTitle,
      showTitle,
      showEmojiAtEnd,
    });

    // Update the modal
    const blocks = [...view.blocks];
    // Find preview block and update its initial_value
    const previewIdx = blocks.findIndex((b) => b.block_id === "preview_block");
    if (previewIdx !== -1) {
      blocks[previewIdx] = {
        ...blocks[previewIdx],
        text: {
          type: "mrkdwn",
          text: "```\n" + preview + "\n```",
        },
      };
    }

    const new_private_metadata = JSON.stringify({
      ...private_metadata,
      preview,
    });

    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: {
        type: view.type,
        title: view.title,
        blocks: blocks,
        callback_id: view.callback_id,
        private_metadata: new_private_metadata,
        submit: view.submit,
        close: view.close,
      },
    });
  });
});

app.view("bar_chart_column_select", async ({ ack, view, body, client }) => {
  const private_metadata = JSON.parse(view.private_metadata || "{}");
  const rawTableData = private_metadata.rawTableData;
  const chartTitle = private_metadata.chartTitle;

  const labelCol =
    view.state.values.label_column_block.label_column.selected_option.value;
  const valueCol =
    view.state.values.value_column_block.value_column.selected_option.value;

  // Parse data for emoji recommendations
  const lines = rawTableData.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = lines
    .slice(1)
    .map((line) => line.split(",").map((cell) => cell.trim()));

  const tableData = { headers, rows };
  const tableDescription = chartTitle || "Data visualization";

  // Get recommended emojis
  const labelEmojis = await recommendEmojis(
    labelCol,
    tableData,
    tableDescription
  );
  const valueEmojis = await recommendEmojis(
    valueCol,
    tableData,
    tableDescription
  );

  // Prepare preview (initial, no emoji for label, first value emoji, no legend)
  // Aggregate by label
  const labelIdx = headers.indexOf(labelCol);
  const valueIdx = headers.indexOf(valueCol);
  const agg = {};
  rows.forEach((row) => {
    const label = row[labelIdx];
    const value = Number(row[valueIdx]);
    agg[label] = (agg[label] || 0) + value;
  });

  const labelEmoji = "none";
  const valueEmoji = valueEmojis[0]?.emoji || "⬜";
  const showTitle = true; // default checked
  const showLegend = false; // default unchecked
  const showEmojiAtEnd = false; // default show all emojis

  // default is just the title name
  const preview = generateBarChartPreview({
    agg,
    labelEmoji,
    valueEmoji,
    showLabelEmoji: labelEmoji !== "none",
    showLegend,
    valueCol,
    chartTitle,
    showTitle,
    showEmojiAtEnd,
  });

  const new_private_metadata = JSON.stringify({
    ...private_metadata,
    labelCol,
    valueCol,
    preview,
  });

  await ack({
    response_action: "push",
    view: {
      type: "modal",
      callback_id: "post_final_message",
      private_metadata: new_private_metadata,
      title: { type: "plain_text", text: "Bar Chart Builder", emoji: true },
      submit: { type: "plain_text", text: "Finish", emoji: true },
      close: { type: "plain_text", text: "Back", emoji: true },
      blocks: [
        {
          type: "section",
          block_id: "label_emoji_block",
          text: {
            type: "mrkdwn",
            text: `*Choose emoji for ${labelCol}*`,
          },
          accessory: {
            type: "static_select",
            action_id: "label_emoji",
            options: [
              {
                text: { type: "plain_text", text: "No label" },
                value: "none",
              },
              ...labelEmojis.map((e) => ({
                text: { type: "plain_text", text: `${e.emoji}` },
                value: e.emoji,
              })),
            ],
            initial_option: {
              text: { type: "plain_text", text: "No label" },
              value: "none",
            },
          },
        },
        {
          type: "section",
          block_id: "value_emoji_block",
          text: {
            type: "mrkdwn",
            text: `*Choose emoji for ${valueCol}*`,
          },
          accessory: {
            type: "static_select",
            action_id: "value_emoji",
            options:
              valueEmojis.length > 0
                ? valueEmojis.map((e) => ({
                    text: { type: "plain_text", text: `${e.emoji}` },
                    value: e.emoji,
                  }))
                : [
                    {
                      text: {
                        type: "plain_text",
                        text: "⬜ (no emoji available)",
                      },
                      value: "⬜",
                    },
                  ],
            initial_option:
              valueEmojis.length > 0
                ? {
                    text: {
                      type: "plain_text",
                      text: `${valueEmojis[0].emoji}`,
                    },
                    value: valueEmojis[0].emoji,
                  }
                : {
                    text: {
                      type: "plain_text",
                      text: "⬜ (no emoji available)",
                    },
                    value: "⬜",
                  },
          },
        },
        {
          type: "section",
          block_id: "show_end_emoji_block",
          text: {
            type: "mrkdwn",
            text: "*Show emoji only at the end of each bar?*",
          },
          accessory: {
            type: "checkboxes",
            action_id: "show_end_emoji_checkbox",
            options: [
              {
                text: {
                  type: "plain_text",
                  text: "Show emoji only at the end",
                },
                value: "show",
              },
            ],
          },
        },
        {
          type: "section",
          block_id: "show_title_block",
          text: {
            type: "mrkdwn",
            text: "*Show chart title?*",
          },
          accessory: {
            type: "checkboxes",
            action_id: "show_title_checkbox",
            options: [
              {
                text: { type: "plain_text", text: "Show chart title" },
                value: "show",
              },
            ],
            initial_options: [
              {
                text: { type: "plain_text", text: "Show chart title" },
                value: "show",
              },
            ],
          },
        },
        {
          type: "section",
          block_id: "show_legend_block",
          text: {
            type: "mrkdwn",
            text: "*Show legend?*",
          },
          accessory: {
            type: "checkboxes",
            action_id: "show_legend",
            options: [
              {
                text: { type: "plain_text", text: "Show legend" },
                value: "show",
              },
            ],
          },
        },
        {
          type: "section",
          block_id: "preview_label_block",
          text: {
            type: "mrkdwn",
            text: "*Preview*",
          },
        },
        {
          type: "section",
          block_id: "preview_block",
          text: {
            type: "mrkdwn",
            text: "```\n" + preview + "\n```",
          },
        },
      ],
    },
  });
});

/// SINGLE VALUE CHART ///
function generateSingleValueChartPreview({
  agg,
  labelEmoji,
  lowEmoji = "👎",
  mediumEmoji = "😐",
  highEmoji = "👍",
  showLabelEmoji,
  showLegend,
  minRange,
  maxRange,
  chartTitle,
  showTitle = true,
}) {
  const entries = Object.entries(agg);
  if (entries.length === 0) return "No data to display.";

  // sort entries in chronological order by the label column values
  const sortedEntries = [...entries].sort(([a], [b]) => {
    const aNum = Number(a);
    const bNum = Number(b);
    if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
    return String(a).localeCompare(String(b));
  });

  // auto-calculate thresholds if user input is not given
  const values = sortedEntries.map(([, val]) => val).sort((a, b) => a - b);
  const min = minRange !== null ? minRange : values[0];
  const max = maxRange !== null ? maxRange : values[values.length - 1];
  const range = max - min;

  // add user input lowThreshold and highThreshold if possible
  const lowT = min + range / 3;
  const highT = min + (2 * range) / 3;

  const maxLabelWidth = Math.max(
    ...entries.map(([label]) => {
      const labelPart =
        showLabelEmoji && labelEmoji ? `${labelEmoji} ${label}` : label;
      return stringWidth(labelPart);
    })
  );

  let preview = entries
    .map(([label, val]) => {
      let emoji = mediumEmoji;
      if (val <= lowT) emoji = lowEmoji;
      else if (val >= highT) emoji = highEmoji;

      const labelPart =
        showLabelEmoji && labelEmoji ? `${labelEmoji} ${label}` : label;
      const paddingNeeded = maxLabelWidth - stringWidth(labelPart);
      const paddedLabel = labelPart + " ".repeat(paddingNeeded);

      return `${paddedLabel}  ${emoji}`;
    })
    .join("\n");

  if (showLegend) {
    preview += `\n\nLegend: ${lowEmoji} = low, ${mediumEmoji} = medium, ${highEmoji} = high`;
  }

  if (showTitle && chartTitle) {
    preview = `${chartTitle}\n\n${preview}`;
  }

  return preview;
}

const singleValueChartEmojiActions = [
  "label_emoji_svc",
  "low_emoji_svc",
  "medium_emoji_svc",
  "high_emoji_svc",
  "show_legend_svc",
  "show_title_checkbox_svc",
];

singleValueChartEmojiActions.forEach((actionId) => {
  app.action(actionId, async ({ body, ack, client }) => {
    await ack();

    const view = body.view;
    const state = view?.state?.values || {};
    const private_metadata = JSON.parse(view.private_metadata || "{}");

    const rawTableData = private_metadata.rawTableData;
    const labelCol = private_metadata.labelCol;
    const valueCol = private_metadata.valueCol;
    const chartTitle = private_metadata.chartTitle;
    const minRange = private_metadata.minRange;
    const maxRange = private_metadata.maxRange;

    // defaults
    let labelEmoji = "none";
    let lowEmoji = "👎";
    let mediumEmoji = "😐";
    let highEmoji = "👍";
    let showLegend = false;
    let showTitle = true;

    // iterate over state (like in trend chart)
    Object.keys(state).forEach((blockId) => {
      const block = state[blockId];
      Object.keys(block).forEach((aId) => {
        const selected = block[aId];

        if (aId === "label_emoji_svc") {
          labelEmoji = selected?.selected_option?.value || "none";
        }
        if (aId === "low_emoji_svc") {
          lowEmoji = selected?.selected_option?.value || "👎";
        }
        if (aId === "medium_emoji_svc") {
          mediumEmoji = selected?.selected_option?.value || "😐";
        }
        if (aId === "high_emoji_svc") {
          highEmoji = selected?.selected_option?.value || "👍";
        }
        if (aId === "show_legend_svc") {
          showLegend =
            selected?.selected_options?.some((opt) => opt.value === "show") ||
            false;
        }
        if (aId === "show_title_checkbox_svc") {
          showTitle =
            selected?.selected_options?.some((opt) => opt.value === "show") ??
            true;
        }
      });
    });

    const showLabelEmoji = labelEmoji !== "none";

    // parse and aggregate
    const lines = rawTableData.trim().split("\n");
    const headers = lines[0].split(",").map((h) => h.trim());
    const rows = lines
      .slice(1)
      .map((line) => line.split(",").map((cell) => cell.trim()));
    const labelIdx = headers.indexOf(labelCol);
    const valueIdx = headers.indexOf(valueCol);

    const agg = {};
    rows.forEach((row) => {
      const label = row[labelIdx];
      const value = Number(row[valueIdx]);
      if (!isNaN(value)) {
        agg[label] = (agg[label] || 0) + value;
      }
    });

    const preview = generateSingleValueChartPreview({
      agg,
      labelEmoji,
      lowEmoji,
      mediumEmoji,
      highEmoji,
      showLabelEmoji,
      showLegend,
      minRange,
      maxRange,
      chartTitle,
      showTitle,
    });

    // update preview block
    const blocks = [...view.blocks];
    const previewIdx = blocks.findIndex(
      (b) => b.block_id === "preview_block_svc"
    );
    if (previewIdx !== -1) {
      blocks[previewIdx] = {
        ...blocks[previewIdx],
        text: {
          type: "mrkdwn",
          text: "```\n" + preview + "\n```",
        },
      };
    }

    // update metadata
    const new_private_metadata = JSON.stringify({
      ...private_metadata,
      preview,
    });

    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: {
        type: view.type,
        title: view.title,
        blocks,
        callback_id: view.callback_id,
        private_metadata: new_private_metadata,
        submit: view.submit,
        close: view.close,
      },
    });
  });
});

app.view("single_value_column_select", async ({ ack, view, body, client }) => {
  const private_metadata = JSON.parse(view.private_metadata || "{}");
  const rawTableData = private_metadata.rawTableData;
  const chartTitle = private_metadata.chartTitle;

  const labelCol =
    view.state.values.label_column_block.label_column.selected_option.value;
  const valueCol =
    view.state.values.value_column_block.value_column.selected_option.value;

  // optional numeric range inputs
  const lowStr =
    view.state.values.value_range_low_block?.value_range_low_input?.value;
  const highStr =
    view.state.values.value_range_high_block?.value_range_high_input?.value;

  let low = null;
  let high = null;
  if (lowStr && highStr) {
    low = parseFloat(lowStr);
    high = parseFloat(highStr);

    if (isNaN(low) || isNaN(high)) {
      await ack({
        response_action: "errors",
        errors: {
          value_range_low_block: "Low and High must both be valid numbers.",
        },
      });
      return;
    }

    if (low >= high) {
      await ack({
        response_action: "errors",
        errors: {
          value_range_low_block: "Low must be less than High.",
        },
      });
      return;
    }
  }

  const minRange = low;
  const maxRange = high;

  // parse CSV
  const lines = rawTableData.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = lines
    .slice(1)
    .map((line) => line.split(",").map((cell) => cell.trim()));

  const labelIdx = headers.indexOf(labelCol);
  const valueIdx = headers.indexOf(valueCol);

  // aggregate values
  const agg = {};
  rows.forEach((row) => {
    const label = row[labelIdx];
    const value = Number(row[valueIdx]);
    if (!isNaN(value)) {
      agg[label] = (agg[label] || 0) + value;
    }
  });

  // placeholder preview
  const placeholderPreview = generateSingleValueChartPreview({
    agg,
    labelEmoji: "none",
    lowEmoji: "❓",
    mediumEmoji: "❓",
    highEmoji: "❓",
    showLabelEmoji: false,
    showLegend: false,
    minRange,
    maxRange,
    chartTitle,
    showTitle: true,
  });

  const new_private_metadata = JSON.stringify({
    ...private_metadata,
    labelCol,
    valueCol,
    minRange,
    maxRange,
    preview: placeholderPreview,
  });

  // ---- initial ack with placeholders ----
  await ack({
    response_action: "push",
    view: {
      type: "modal",
      external_id: "emoji_chart_modal_svc",
      callback_id: "post_final_message",
      private_metadata: new_private_metadata,
      title: { type: "plain_text", text: "Single Value Chart", emoji: true },
      submit: { type: "plain_text", text: "Finish", emoji: true },
      close: { type: "plain_text", text: "Back", emoji: true },
      blocks: [
        {
          type: "section",
          block_id: "loading_block_svc",
          text: { type: "mrkdwn", text: "⏳ Generating emoji recommendations..." },
        },
        {
          type: "section",
          block_id: "label_emoji_block_svc",
          text: { type: "mrkdwn", text: `*Choose emoji for ${labelCol}*` },
          accessory: {
            type: "static_select",
            action_id: "label_emoji_svc",
            options: [
              { text: { type: "plain_text", text: "No label" }, value: "none" },
              { text: { type: "plain_text", text: "❓" }, value: "❓" },
            ],
            initial_option: { text: { type: "plain_text", text: "No label" }, value: "none" },
          },
        },
        {
          type: "section",
          block_id: "low_emoji_block_svc",
          text: { type: "mrkdwn", text: `*Low value emoji for ${valueCol}*` },
          accessory: {
            type: "static_select",
            action_id: "low_emoji_svc",
            options: [{ text: { type: "plain_text", text: "❓" }, value: "❓" }],
            initial_option: { text: { type: "plain_text", text: "❓" }, value: "❓" },
          },
        },
        {
          type: "section",
          block_id: "medium_emoji_block_svc",
          text: { type: "mrkdwn", text: `*Medium value emoji for ${valueCol}*` },
          accessory: {
            type: "static_select",
            action_id: "medium_emoji_svc",
            options: [{ text: { type: "plain_text", text: "❓" }, value: "❓" }],
            initial_option: { text: { type: "plain_text", text: "❓" }, value: "❓" },
          },
        },
        {
          type: "section",
          block_id: "high_emoji_block_svc",
          text: { type: "mrkdwn", text: `*High value emoji for ${valueCol}*` },
          accessory: {
            type: "static_select",
            action_id: "high_emoji_svc",
            options: [{ text: { type: "plain_text", text: "❓" }, value: "❓" }],
            initial_option: { text: { type: "plain_text", text: "❓" }, value: "❓" },
          },
        },
        {
          type: "section",
          block_id: "show_title_block_svc",
          text: { type: "mrkdwn", text: "*Show chart title?*" },
          accessory: {
            type: "checkboxes",
            action_id: "show_title_checkbox_svc",
            options: [{ text: { type: "plain_text", text: "Show chart title" }, value: "show" }],
            initial_options: [{ text: { type: "plain_text", text: "Show chart title" }, value: "show" }],
          },
        },
        {
          type: "section",
          block_id: "show_legend_block_svc",
          text: { type: "mrkdwn", text: "*Show legend?*" },
          accessory: {
            type: "checkboxes",
            action_id: "show_legend_svc",
            options: [{ text: { type: "plain_text", text: "Show legend" }, value: "show" }],
          },
        },
        {
          type: "section",
          block_id: "preview_label_block_svc",
          text: { type: "mrkdwn", text: "*Preview*" },
        },
        {
          type: "section",
          block_id: "preview_block_svc",
          text: { type: "mrkdwn", text: "```\n" + placeholderPreview + "\n```" },
        },
      ],
    },
  });

  // ---- async update with real recs ----
  (async () => {
    const tableData = { headers, rows };
    const tableDescription = chartTitle || "Data visualization";

    const suggestions = await recommendEmojis(tableData, tableDescription);
    const valueEmojiGroups = getRecEmojiOptions(suggestions, valueCol, "scale");
    const labelRecs = getRecEmojiOptions(suggestions, labelCol, "column_name");

    const lowEmoji = valueEmojiGroups.low[0]?.emoji || "📉";
    const mediumEmoji = valueEmojiGroups.medium[0]?.emoji || "😐";
    const highEmoji = valueEmojiGroups.high[0]?.emoji || "📈";

    const updatedPreview = generateSingleValueChartPreview({
      agg,
      labelEmoji: "none",
      lowEmoji,
      mediumEmoji,
      highEmoji,
      showLabelEmoji: false,
      showLegend: false,
      minRange,
      maxRange,
      chartTitle,
      showTitle: true,
    });

    const updatedBlocks = [
      {
        type: "section",
        block_id: `label_emoji_block_svc_${Date.now()}`,
        text: { type: "mrkdwn", text: `*Choose emoji for ${labelCol}*` },
        accessory: {
          type: "static_select",
          action_id: "label_emoji_svc",
          options: [
            { text: { type: "plain_text", text: "No label" }, value: "none" },
            ...labelRecs.map((e) => ({ text: { type: "plain_text", text: e.emoji }, value: e.emoji })),
          ],
          initial_option: { text: { type: "plain_text", text: "No label" }, value: "none" },
        },
      },
      {
        type: "section",
        block_id: `low_emoji_block_svc_${Date.now()}`,
        text: { type: "mrkdwn", text: `*Low value emoji for ${valueCol}*` },
        accessory: {
          type: "static_select",
          action_id: "low_emoji_svc",
          options: valueEmojiGroups.low.map((e) => ({
            text: { type: "plain_text", text: e.emoji },
            value: e.emoji,
          })),
          initial_option: { text: { type: "plain_text", text: lowEmoji }, value: lowEmoji },
        },
      },
      {
        type: "section",
        block_id: `medium_emoji_block_svc_${Date.now()}`,
        text: { type: "mrkdwn", text: `*Medium value emoji for ${valueCol}*` },
        accessory: {
          type: "static_select",
          action_id: "medium_emoji_svc",
          options: valueEmojiGroups.medium.map((e) => ({
            text: { type: "plain_text", text: e.emoji },
            value: e.emoji,
          })),
          initial_option: { text: { type: "plain_text", text: mediumEmoji }, value: mediumEmoji },
        },
      },
      {
        type: "section",
        block_id: `high_emoji_block_svc_${Date.now()}`,
        text: { type: "mrkdwn", text: `*High value emoji for ${valueCol}*` },
        accessory: {
          type: "static_select",
          action_id: "high_emoji_svc",
          options: valueEmojiGroups.high.map((e) => ({
            text: { type: "plain_text", text: e.emoji },
            value: e.emoji,
          })),
          initial_option: { text: { type: "plain_text", text: highEmoji }, value: highEmoji },
        },
      },
      {
        type: "section",
        block_id: "show_title_block_svc",
        text: { type: "mrkdwn", text: "*Show chart title?*" },
        accessory: {
          type: "checkboxes",
          action_id: "show_title_checkbox_svc",
          options: [{ text: { type: "plain_text", text: "Show chart title" }, value: "show" }],
          initial_options: [{ text: { type: "plain_text", text: "Show chart title" }, value: "show" }],
        },
      },
      {
        type: "section",
        block_id: "show_legend_block_svc",
        text: { type: "mrkdwn", text: "*Show legend?*" },
        accessory: {
          type: "checkboxes",
          action_id: "show_legend_svc",
          options: [{ text: { type: "plain_text", text: "Show legend" }, value: "show" }],
        },
      },
      {
        type: "section",
        block_id: "preview_block_svc",
        text: { type: "mrkdwn", text: "```\n" + updatedPreview + "\n```" },
      },
    ];

    await client.views.update({
      external_id: "emoji_chart_modal_svc",
      view: {
        type: "modal",
        callback_id: "post_final_message",
        title: { type: "plain_text", text: "Single Value Chart", emoji: true },
        submit: { type: "plain_text", text: "Finish", emoji: true },
        close: { type: "plain_text", text: "Back", emoji: true },
        private_metadata: JSON.stringify({
          ...private_metadata,
          labelCol,
          valueCol,
          minRange,
          maxRange,
          preview: updatedPreview,
        }),
        blocks: updatedBlocks,
      },
    });
  })();
});

// TREND CHART //
function generateTrendChartPreview({
  entries,
  labelEmoji,
  labelCol,
  lowEmoji = "📉",
  mediumEmoji = "😐",
  highEmoji = "📈",
  showLabelEmoji,
  showLegend,
  minRange,
  maxRange,
  chartTitle,
  showTitle = true,
}) {
  if (entries.length === 0) return "No data to display.";

  // auto-calculate thresholds if user input is not given
  const values = entries.map(([, val]) => val).sort((a, b) => a - b);
  const min =
    minRange !== null && minRange !== undefined ? minRange : values[0];
  const max =
    maxRange !== null && maxRange !== undefined
      ? maxRange
      : values[values.length - 1];
  const range = max - min;

  // add user input lowThreshold and highThreshold if possible
  const lowT = min + range / 3;
  const highT = min + (2 * range) / 3;

  let preview = `${showLabelEmoji ? labelEmoji : ""}${labelCol} `;

  preview += entries
    .map(([_, val]) => {
      let emoji = mediumEmoji;
      if (val <= lowT) emoji = lowEmoji;
      else if (val >= highT) emoji = highEmoji;
      return `${emoji}`;
    })
    .join("");

  if (showLegend) {
    preview += `\n\nLegend: ${lowEmoji} = low, ${mediumEmoji} = medium, ${highEmoji} = high`;
  }

  if (showTitle && chartTitle) {
    preview = `${chartTitle}\n\n${preview}`;
  }

  return preview;
}

const trendChartEmojiActions = [
  "label_emoji_tc",
  "low_emoji_tc",
  "medium_emoji_tc",
  "high_emoji_tc",
  "show_legend_tc",
  "show_title_checkbox_tc",
];

trendChartEmojiActions.forEach((actionId) => {
  app.action(actionId, async ({ body, ack, client }) => {
    await ack();

    const view = body.view;
    const state = view?.state?.values || {};
    const private_metadata = JSON.parse(view.private_metadata || "{}");

    const rawTableData = private_metadata.rawTableData;
    const labelCol = private_metadata.labelCol;
    const valueCol = private_metadata.valueCol;
    const chartTitle = private_metadata.chartTitle;
    const minRange = private_metadata.minRange;
    const maxRange = private_metadata.maxRange;

    // defaults
    let labelEmoji = "none";
    let lowEmoji = "📉";
    let mediumEmoji = "😐";
    let highEmoji = "📈";
    let showLegend = false;
    let showTitle = true;

    // iterate state like in proportion handler
    Object.keys(state).forEach((blockId) => {
      const block = state[blockId];
      Object.keys(block).forEach((aId) => {
        const selected = block[aId];

        if (aId === "label_emoji_tc") {
          labelEmoji = selected?.selected_option?.value || "none";
        }
        if (aId === "low_emoji_tc") {
          lowEmoji = selected?.selected_option?.value || "📉";
        }
        if (aId === "medium_emoji_tc") {
          mediumEmoji = selected?.selected_option?.value || "😐";
        }
        if (aId === "high_emoji_tc") {
          highEmoji = selected?.selected_option?.value || "📈";
        }
        if (aId === "show_legend_tc") {
          showLegend =
            selected?.selected_options?.some((opt) => opt.value === "show") ||
            false;
        }
        if (aId === "show_title_checkbox_tc") {
          showTitle =
            selected?.selected_options?.some((opt) => opt.value === "show") ??
            true;
        }
      });
    });

    const showLabelEmoji = labelEmoji !== "none";

    // parse CSV data
    const lines = rawTableData.trim().split("\n");
    const headers = lines[0].split(",").map((h) => h.trim());
    const rows = lines
      .slice(1)
      .map((line) => line.split(",").map((cell) => cell.trim()));
    const labelIdx = headers.indexOf(labelCol);
    const valueIdx = headers.indexOf(valueCol);

    const entries = rows
      .map((row) => [row[labelIdx], Number(row[valueIdx])])
      .filter(([_, val]) => !isNaN(val))
      .sort((a, b) => compareTemporalLabels(a[0], b[0]));

    const preview = generateTrendChartPreview({
      entries,
      labelEmoji,
      labelCol,
      lowEmoji,
      mediumEmoji,
      highEmoji,
      showLabelEmoji,
      showLegend,
      minRange,
      maxRange,
      chartTitle,
      showTitle,
    });

    // update preview block
    const blocks = [...view.blocks];
    const previewIdx = blocks.findIndex(
      (b) => b.block_id === "preview_block_tc"
    );
    if (previewIdx !== -1) {
      blocks[previewIdx] = {
        ...blocks[previewIdx],
        text: {
          type: "mrkdwn",
          text: "```\n" + preview + "\n```",
        },
      };
    }

    // update metadata
    const new_private_metadata = JSON.stringify({
      ...private_metadata,
      preview,
    });

    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: {
        type: view.type,
        title: view.title,
        blocks,
        callback_id: view.callback_id,
        private_metadata: new_private_metadata,
        submit: view.submit,
        close: view.close,
      },
    });
  });
});

app.view("trend_chart_column_select", async ({ ack, view, body, client }) => {
  const private_metadata = JSON.parse(view.private_metadata || "{}");
  const rawTableData = private_metadata.rawTableData;
  const chartTitle = private_metadata.chartTitle;

  const labelCol =
    view.state.values.label_column_block.label_column.selected_option.value;
  const valueCol =
    view.state.values.value_column_block.value_column.selected_option.value;

  // labelCol cannot be the same as valueCol
  if (labelCol === valueCol) {
    await ack({
      response_action: "errors",
      errors: {
        value_column_block:
          "Value column must be different from the label column.",
      },
    });
    return;
  }

  // optional numeric range inputs
  const lowStr =
    view.state.values.value_range_low_block?.value_range_low_input?.value;
  const highStr =
    view.state.values.value_range_high_block?.value_range_high_input?.value;

  let low = null;
  let high = null;
  if (lowStr && highStr) {
    low = parseFloat(lowStr);
    high = parseFloat(highStr);

    if (isNaN(low) || isNaN(high)) {
      await ack({
        response_action: "errors",
        errors: {
          value_range_low_block: "Low and High must both be valid numbers.",
        },
      });
      return;
    }

    if (low >= high) {
      await ack({
        response_action: "errors",
        errors: {
          value_range_low_block: "Low must be less than High.",
        },
      });
      return;
    }
  }

  const minRange = low;
  const maxRange = high;

  // Parse CSV
  const lines = rawTableData.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = lines
    .slice(1)
    .map((line) => line.split(",").map((cell) => cell.trim()));

  const labelIdx = headers.indexOf(labelCol);
  const valueIdx = headers.indexOf(valueCol);

  const entries = rows
    .map((row) => [row[labelIdx], Number(row[valueIdx])])
    .filter(([_, val]) => !isNaN(val))
    .sort((a, b) => compareTemporalLabels(a[0], b[0]));

  // ---- placeholder preview ----
  const placeholderPreview = generateTrendChartPreview({
    entries,
    labelEmoji: "none",
    labelCol,
    lowEmoji: "❓",
    mediumEmoji: "❓",
    highEmoji: "❓",
    showLabelEmoji: false,
    showLegend: false,
    minRange,
    maxRange,
    chartTitle,
    showTitle: true,
  });

  const new_private_metadata = JSON.stringify({
    ...private_metadata,
    labelCol,
    valueCol,
    minRange,
    maxRange,
    preview: placeholderPreview,
  });

  // ---- load modal with placeholders ----
  await ack({
    response_action: "push",
    view: {
      type: "modal",
      external_id: "emoji_chart_modal_trend",
      callback_id: "post_final_message",
      private_metadata: new_private_metadata,
      title: { type: "plain_text", text: "Trend Chart", emoji: true },
      submit: { type: "plain_text", text: "Finish", emoji: true },
      close: { type: "plain_text", text: "Back", emoji: true },
      blocks: [
        {
          type: "section",
          block_id: "loading_block_tc",
          text: {
            type: "mrkdwn",
            text: "⏳ Generating emoji recommendations...",
          },
        },
        {
          type: "section",
          block_id: "label_emoji_block_tc",
          text: { type: "mrkdwn", text: `*Choose emoji for ${labelCol}*` },
          accessory: {
            type: "static_select",
            action_id: "label_emoji_tc",
            options: [
              { text: { type: "plain_text", text: "No label" }, value: "none" },
              { text: { type: "plain_text", text: "❓" }, value: "❓" },
            ],
            initial_option: {
              text: { type: "plain_text", text: "No label" },
              value: "none",
            },
          },
        },
        {
          type: "section",
          block_id: "low_emoji_block_tc",
          text: { type: "mrkdwn", text: `*Low value emoji for ${valueCol}*` },
          accessory: {
            type: "static_select",
            action_id: "low_emoji_tc",
            options: [
              { text: { type: "plain_text", text: "❓" }, value: "❓" },
            ],
            initial_option: {
              text: { type: "plain_text", text: "❓" },
              value: "❓",
            },
          },
        },
        {
          type: "section",
          block_id: "medium_emoji_block_tc",
          text: {
            type: "mrkdwn",
            text: `*Medium value emoji for ${valueCol}*`,
          },
          accessory: {
            type: "static_select",
            action_id: "medium_emoji_tc",
            options: [
              { text: { type: "plain_text", text: "❓" }, value: "❓" },
            ],
            initial_option: {
              text: { type: "plain_text", text: "❓" },
              value: "❓",
            },
          },
        },
        {
          type: "section",
          block_id: "high_emoji_block_tc",
          text: { type: "mrkdwn", text: `*High value emoji for ${valueCol}*` },
          accessory: {
            type: "static_select",
            action_id: "high_emoji_tc",
            options: [
              { text: { type: "plain_text", text: "❓" }, value: "❓" },
            ],
            initial_option: {
              text: { type: "plain_text", text: "❓" },
              value: "❓",
            },
          },
        },
        {
          type: "section",
          block_id: "show_title_block_tc",
          text: { type: "mrkdwn", text: "*Show chart title?*" },
          accessory: {
            type: "checkboxes",
            action_id: "show_title_checkbox_tc",
            options: [
              {
                text: { type: "plain_text", text: "Show chart title" },
                value: "show",
              },
            ],
            initial_options: [
              {
                text: { type: "plain_text", text: "Show chart title" },
                value: "show",
              },
            ],
          },
        },
        {
          type: "section",
          block_id: "show_legend_block_tc",
          text: { type: "mrkdwn", text: "*Show legend?*" },
          accessory: {
            type: "checkboxes",
            action_id: "show_legend_tc",
            options: [
              {
                text: { type: "plain_text", text: "Show legend" },
                value: "show",
              },
            ],
          },
        },
        {
          type: "section",
          block_id: "preview_label_block_tc",
          text: { type: "mrkdwn", text: "*Preview*" },
        },
        {
          type: "section",
          block_id: "preview_block_tc",
          text: {
            type: "mrkdwn",
            text: "```\n" + placeholderPreview + "\n```",
          },
        },
      ],
    },
  });

  // ---- generate recommendations ----
  (async () => {
    const tableData = { headers, rows };
    const tableDescription = chartTitle || "Data visualization";

    const suggestions = await recommendEmojis(tableData, tableDescription);
    const valueEmojiGroups = getRecEmojiOptions(suggestions, valueCol, "scale");
    const labelRecs = getRecEmojiOptions(suggestions, labelCol, "column_name");

    const lowEmoji = valueEmojiGroups.low[0]?.emoji || "📉";
    const mediumEmoji = valueEmojiGroups.medium[0]?.emoji || "😐";
    const highEmoji = valueEmojiGroups.high[0]?.emoji || "📈";

    const updatedPreview = generateTrendChartPreview({
      entries,
      labelEmoji: "none",
      labelCol,
      lowEmoji,
      mediumEmoji,
      highEmoji,
      showLabelEmoji: false,
      showLegend: false,
      minRange,
      maxRange,
      chartTitle,
      showTitle: true,
    });

    const updatedBlocks = [
      {
        type: "section",
        block_id: `label_emoji_block_tc_${Date.now()}`,
        text: { type: "mrkdwn", text: `*Choose emoji for ${labelCol}*` },
        accessory: {
          type: "static_select",
          action_id: "label_emoji_tc",
          options: [
            { text: { type: "plain_text", text: "No label" }, value: "none" },
            ...labelRecs.map((e) => ({
              text: { type: "plain_text", text: e.emoji },
              value: e.emoji,
            })),
          ],
          initial_option: {
            text: {
              type: "plain_text",
              text: "No label",
            },
            value: "none",
          },
        },
      },
      {
        type: "section",
        block_id: `low_emoji_block_tc_${Date.now()}`,
        text: { type: "mrkdwn", text: `*Low value emoji for ${valueCol}*` },
        accessory: {
          type: "static_select",
          action_id: "low_emoji_tc",
          options: valueEmojiGroups.low.map((e) => ({
            text: { type: "plain_text", text: e.emoji },
            value: e.emoji,
          })),
          initial_option: {
            text: { type: "plain_text", text: lowEmoji },
            value: lowEmoji,
          },
        },
      },
      {
        type: "section",
        block_id: `medium_emoji_block_tc_${Date.now()}`,
        text: { type: "mrkdwn", text: `*Medium value emoji for ${valueCol}*` },
        accessory: {
          type: "static_select",
          action_id: "medium_emoji_tc",
          options: valueEmojiGroups.medium.map((e) => ({
            text: { type: "plain_text", text: e.emoji },
            value: e.emoji,
          })),
          initial_option: {
            text: { type: "plain_text", text: mediumEmoji },
            value: mediumEmoji,
          },
        },
      },
      {
        type: "section",
        block_id: `high_emoji_block_tc_${Date.now()}`,
        text: { type: "mrkdwn", text: `*High value emoji for ${valueCol}*` },
        accessory: {
          type: "static_select",
          action_id: "high_emoji_tc",
          options: valueEmojiGroups.high.map((e) => ({
            text: { type: "plain_text", text: e.emoji },
            value: e.emoji,
          })),
          initial_option: {
            text: { type: "plain_text", text: highEmoji },
            value: highEmoji,
          },
        },
      },
      {
        type: "section",
        block_id: "show_title_block_tc",
        text: { type: "mrkdwn", text: "*Show chart title?*" },
        accessory: {
          type: "checkboxes",
          action_id: "show_title_checkbox_tc",
          options: [
            {
              text: { type: "plain_text", text: "Show chart title" },
              value: "show",
            },
          ],
          initial_options: [
            {
              text: { type: "plain_text", text: "Show chart title" },
              value: "show",
            },
          ],
        },
      },
      {
        type: "section",
        block_id: "show_legend_block_tc",
        text: { type: "mrkdwn", text: "*Show legend?*" },
        accessory: {
          type: "checkboxes",
          action_id: "show_legend_tc",
          options: [
            {
              text: { type: "plain_text", text: "Show legend" },
              value: "show",
            },
          ],
        },
      },
      {
        type: "section",
        block_id: "preview_block_tc",
        text: { type: "mrkdwn", text: "```\n" + updatedPreview + "\n```" },
      },
    ];

    await client.views.update({
      external_id: "emoji_chart_modal_trend",
      view: {
        type: "modal",
        callback_id: "post_final_message",
        title: { type: "plain_text", text: "Trend Chart", emoji: true },
        submit: { type: "plain_text", text: "Finish", emoji: true },
        close: { type: "plain_text", text: "Back", emoji: true },
        private_metadata: JSON.stringify({
          ...private_metadata,
          labelCol,
          valueCol,
          minRange,
          maxRange,
          preview: updatedPreview,
        }),
        blocks: updatedBlocks,
      },
    });
  })();
});

// PROPORTION CHART //
function generateProportionChartPreview({
  agg, // aggregated data where each element is in the form of ["labelname", count]
  emojiMap, // recommended emoji map in the form of { "labelname": emoji }; should only pertain to top 5 labels
  chartTitle,
  numEmojisPerLine = 10,
  showTitle = true,
  showLegend = true,
  defaultEmoji = "📦",
}) {
  const totalSlots = numEmojisPerLine * numEmojisPerLine;

  const sorted = Object.entries(agg).sort((a, b) => b[1] - a[1]);
  const topFive = sorted.slice(0, 5);

  const hasOther = sorted.length > 5;

  const frequencySum = sorted.reduce((sum, [, count]) => sum + count, 0);

  let emojiSlots = [];

  // allocate slots for each top category proportionally
  for (const [label, count] of topFive) {
    const emoji = emojiMap[label.toLowerCase()] || "🔹";
    const slotCount = Math.max(
      Math.round((count / frequencySum) * totalSlots),
      1
    );
    emojiSlots.push(...Array(slotCount).fill(emoji));
  }

  // fill remaining space
  if (emojiSlots.length < totalSlots) {
    emojiSlots.push(
      ...Array(totalSlots - emojiSlots.length).fill(defaultEmoji)
    );
  } else if (emojiSlots.length > totalSlots) {
    emojiSlots = emojiSlots.slice(0, totalSlots);
  }

  // split into lines
  const previewLines = [];
  for (let i = 0; i < emojiSlots.length; i += numEmojisPerLine) {
    previewLines.push(emojiSlots.slice(i, i + numEmojisPerLine).join(""));
  }

  let preview = previewLines.join("\n");

  // build legend
  if (showLegend) {
    let legend = topFive
      .map(
        ([label]) =>
          `${emojiMap[label.toLowerCase()] || defaultEmoji} = ${label}`
      )
      .join(", ");

    if (hasOther) {
      legend += `, ${defaultEmoji} = Other`;
    }

    preview += `\n\nLegend: ${legend}`;
  }

  // add title
  if (showTitle && chartTitle) {
    preview = `${chartTitle}\n\n${preview}`;
  }

  return preview;
}

const proportionChartEmojiActions = [
  "show_legend_por",
  "show_title_checkbox_por",
  "por_label_emoji_0",
  "por_label_emoji_1",
  "por_label_emoji_2",
  "por_label_emoji_3",
  "por_label_emoji_4",
];
proportionChartEmojiActions.forEach((actionId) => {
  app.action(actionId, async ({ body, ack, client }) => {
    await ack();
    const view = body.view;
    const state = view?.state?.values || {};
    const private_metadata = JSON.parse(view.private_metadata || "{}");

    const rawTableData = private_metadata.rawTableData;
    const labelCol = private_metadata.labelCol;
    const chartTitle = private_metadata.chartTitle || "";
    const emojiMap = { ...private_metadata.emojiMap };
    const freqCol = private_metadata.freqCol || "none";

    // Update emojiMap based on the current state
    Object.keys(state).forEach((blockId) => {
      const block = state[blockId];
      Object.keys(block).forEach((actionId) => {
        if (/^por_label_emoji_\d$/.test(actionId)) {
          // Grab the label text from the block (same index)
          const labelText = view.blocks.find((b) => b.block_id === blockId)
            ?.text?.text;
          const selected = block[actionId]?.selected_option?.value;
          if (labelText && selected) {
            emojiMap[labelText.toLowerCase()] = selected;
          }
        }
      });
    });

    const showLegend =
      state.show_legend_block_por?.show_legend_por?.selected_options?.some(
        (opt) => opt.value === "show"
      ) || false;

    const showTitle =
      state.show_title_block_por?.show_title_checkbox_por?.selected_options?.some(
        (opt) => opt.value === "show"
      ) ?? true;

    // parse CSV data
    const lines = rawTableData.trim().split("\n");
    const headers = lines[0].split(",").map((h) => h.trim());
    const rows = lines
      .slice(1)
      .map((line) => line.split(",").map((cell) => cell.trim()));

    const labelIdx = headers.indexOf(labelCol);

    // count frequency of each label
    const agg = {};

    if (freqCol !== "none") {
      // use frequency specified by the frequency column if selected
      const freqIdx = headers.indexOf(freqCol);

      rows.forEach((row) => {
        const rawLabel = row[labelIdx]?.trim() || "unknown";
        const key = rawLabel.toLowerCase();

        const rawFreq = row[freqIdx]?.trim();
        const freqVal = Number(rawFreq);

        if (!isNaN(freqVal)) {
          agg[key] = (agg[key] || 0) + freqVal;
        }
      });
    } else {
      // else, use the count of each unique label
      rows.forEach((row) => {
        const rawLabel = row[labelIdx]?.trim() || "unknown";
        const key = rawLabel.toLowerCase();
        agg[key] = (agg[key] || 0) + 1;
      });
    }

    // Generate preview
    const formattedPreview = generateProportionChartPreview({
      agg,
      emojiMap,
      chartTitle,
      showTitle,
      showLegend,
      numEmojisPerLine:
        Number(
          state.num_emojis_per_line_block?.num_emojis_per_line_input?.value
        ) || 10,
    });

    // Update preview block
    const blocks = [...view.blocks];
    const previewIdx = blocks.findIndex(
      (b) => b.block_id === "preview_block_por"
    );
    if (previewIdx !== -1) {
      blocks[previewIdx] = {
        ...blocks[previewIdx],
        text: {
          type: "mrkdwn",
          text: "```\n" + formattedPreview + "\n```",
        },
      };
    }

    // Update metadata & view
    const new_private_metadata = JSON.stringify({
      ...private_metadata,
      emojiMap,
      preview: formattedPreview,
    });

    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: {
        type: view.type,
        title: view.title,
        blocks,
        callback_id: view.callback_id,
        private_metadata: new_private_metadata,
        submit: view.submit,
        close: view.close,
      },
    });
  });
});

app.view(
  "proportion_chart_column_select",
  async ({ ack, view, body, client }) => {
    const private_metadata = JSON.parse(view.private_metadata || "{}");
    const rawTableData = private_metadata.rawTableData;
    const chartTitle = private_metadata.chartTitle;

    const labelCol =
      view.state.values.value_column_block.value_column.selected_option.value;
    const freqCol =
      view.state.values.numeric_column_block.numeric_column.selected_option
        .value;

    // parse CSV data
    const lines = rawTableData.trim().split("\n");
    const headers = lines[0].split(",").map((h) => h.trim());
    const rows = lines
      .slice(1)
      .map((line) => line.split(",").map((cell) => cell.trim()));
    const labelIdx = headers.indexOf(labelCol);

    // count frequency of each label
    const agg = {};
    if (freqCol !== "none") {
      const freqIdx = headers.indexOf(freqCol);
      rows.forEach((row) => {
        const key = (row[labelIdx]?.trim() || "unknown").toLowerCase();
        const freqVal = Number(row[freqIdx]?.trim());
        if (!isNaN(freqVal)) agg[key] = (agg[key] || 0) + freqVal;
      });
    } else {
      rows.forEach((row) => {
        const key = (row[labelIdx]?.trim() || "unknown").toLowerCase();
        agg[key] = (agg[key] || 0) + 1;
      });
    }

    const sortedLabels = Object.entries(agg).sort((a, b) => b[1] - a[1]);
    const topFive = sortedLabels.slice(0, 5).map(([label]) => label);

    // placeholder emoji map
    const placeholderEmojiMap = {};
    topFive.forEach((label) => (placeholderEmojiMap[label] = "❓"));

    const showTitle = true;
    const showLegend = true;
    const numEmojisPerLine =
      Number(
        view.state.values.num_emojis_per_line_block?.num_emojis_per_line_input
          ?.value
      ) || 10;

    const formattedPreview = generateProportionChartPreview({
      agg,
      emojiMap: placeholderEmojiMap,
      chartTitle,
      showTitle,
      showLegend,
      numEmojisPerLine,
    });

    const new_private_metadata = JSON.stringify({
      ...private_metadata,
      labelCol,
      preview: formattedPreview,
      emojiMap: placeholderEmojiMap,
      freqCol,
    });

    // ---- load modal with placeholders first ----
    await ack({
      response_action: "push",
      view: {
        type: "modal",
        callback_id: "post_final_message",
        external_id: "emoji_chart_modal",
        private_metadata: new_private_metadata,
        title: { type: "plain_text", text: "Emoji Chart Builder", emoji: true },
        submit: { type: "plain_text", text: "Finish", emoji: true },
        close: { type: "plain_text", text: "Back", emoji: true },
        blocks: [
          {
            type: "section",
            block_id: "label_emoji_block_loading_por",
            text: {
              type: "mrkdwn",
              text: `⏳ Generating emoji recommendations...`,
            },
          },
          {
            type: "section",
            block_id: "label_emoji_block_por",
            text: {
              type: "mrkdwn",
              text: `*Choose emoji for each unique value in the label column (${labelCol})*`,
            },
          },
          ...topFive.map((label, i) => ({
            type: "section",
            block_id: `label_emoji_block_${i}`,
            text: { type: "mrkdwn", text: label },
            accessory: {
              type: "static_select",
              action_id: `por_label_emoji_${i}`,
              options: [
                { text: { type: "plain_text", text: "❓" }, value: "❓" },
              ],
              initial_option: {
                text: { type: "plain_text", text: "❓" },
                value: "❓",
              },
            },
          })),
          {
            type: "section",
            block_id: "show_title_block_por",
            text: { type: "mrkdwn", text: "*Show chart title?*" },
            accessory: {
              type: "checkboxes",
              action_id: "show_title_checkbox_por",
              options: [
                {
                  text: { type: "plain_text", text: "Show chart title" },
                  value: "show",
                },
              ],
              initial_options: showTitle
                ? [
                    {
                      text: { type: "plain_text", text: "Show chart title" },
                      value: "show",
                    },
                  ]
                : [],
            },
          },
          {
            type: "section",
            block_id: "show_legend_block_por",
            text: { type: "mrkdwn", text: "*Show legend?*" },
            accessory: {
              type: "checkboxes",
              action_id: "show_legend_por",
              options: [
                {
                  text: { type: "plain_text", text: "Show legend" },
                  value: "show",
                },
              ],
              initial_options: showLegend
                ? [
                    {
                      text: { type: "plain_text", text: "Show legend" },
                      value: "show",
                    },
                  ]
                : [],
            },
          },
          {
            type: "section",
            block_id: "preview_label_block_por",
            text: { type: "mrkdwn", text: "*Preview*" },
          },
          {
            type: "section",
            block_id: "preview_block_por",
            text: {
              type: "mrkdwn",
              text: "```\n" + formattedPreview + "\n```",
            },
          },
        ],
      },
    });

    // ---- Asynchronously replace placeholders with real recommendations ----
    (async () => {
      const tableData = { headers, rows };
      const tableDescription = chartTitle || "Data visualization";
      const realEmojiMap = {};
      const suggestions = await recommendEmojis(tableData, tableDescription);

      for (const label of topFive) {
        const recs = getRecEmojiOptions(
          suggestions,
          labelCol, // the column name
          "value", // we want categorical value recommendations
          label // the actual categorical value
        );
        realEmojiMap[label] = recs[0]?.emoji || "❓";
      }

      const updatedPreview = generateProportionChartPreview({
        agg,
        emojiMap: realEmojiMap,
        chartTitle,
        showTitle,
        showLegend,
        numEmojisPerLine,
      });

      const updatedBlocks = [
        {
          type: "section",
          block_id: "label_emoji_block_por",
          text: {
            type: "mrkdwn",
            text: `*Choose emoji for each unique value in the label column (${labelCol})*`,
          },
        },
        ...topFive.map((label, i) => {
          const recs = getRecEmojiOptions(
            suggestions,
            labelCol,
            "value",
            label
          );

          return {
            type: "section",
            block_id: `label_emoji_block_${i}_${Date.now()}`,
            text: { type: "mrkdwn", text: label },
            accessory: {
              type: "static_select",
              action_id: `por_label_emoji_${i}`,
              options: recs.map((e) => ({
                text: { type: "plain_text", text: e.emoji },
                value: e.emoji,
              })),
              initial_option: {
                text: { type: "plain_text", text: realEmojiMap[label] },
                value: realEmojiMap[label],
              },
            },
          };
        }),
        {
          type: "section",
          block_id: "show_title_block_por",
          text: { type: "mrkdwn", text: "*Show chart title?*" },
          accessory: {
            type: "checkboxes",
            action_id: "show_title_checkbox_por",
            options: [
              {
                text: { type: "plain_text", text: "Show chart title" },
                value: "show",
              },
            ],
            initial_options: showTitle
              ? [
                  {
                    text: { type: "plain_text", text: "Show chart title" },
                    value: "show",
                  },
                ]
              : [],
          },
        },
        {
          type: "section",
          block_id: "show_legend_block_por",
          text: { type: "mrkdwn", text: "*Show legend?*" },
          accessory: {
            type: "checkboxes",
            action_id: "show_legend_por",
            options: [
              {
                text: { type: "plain_text", text: "Show legend" },
                value: "show",
              },
            ],
            initial_options: showLegend
              ? [
                  {
                    text: { type: "plain_text", text: "Show legend" },
                    value: "show",
                  },
                ]
              : [],
          },
        },
        {
          type: "section",
          block_id: "preview_block_por",
          text: { type: "mrkdwn", text: "```\n" + updatedPreview + "\n```" },
        },
      ];

      await client.views.update({
        external_id: "emoji_chart_modal",
        view: {
          type: "modal",
          callback_id: "post_final_message",
          title: {
            type: "plain_text",
            text: "Emoji Chart Builder",
            emoji: true,
          },
          submit: { type: "plain_text", text: "Finish", emoji: true },
          close: { type: "plain_text", text: "Back", emoji: true },
          private_metadata: JSON.stringify({
            ...private_metadata,
            labelCol,
            preview: updatedPreview,
            emojiMap: realEmojiMap,
            freqCol,
          }),
          blocks: updatedBlocks,
        },
      });
    })();
  }
);

///////
app.view("post_final_message", async ({ ack, body, view, client }) => {
  await ack({ response_action: "clear" });

  const private_metadata = JSON.parse(view.private_metadata || "{}");
  const { channelId, threadTs, preview } = private_metadata;

  try {
    await client.chat.postMessage({
      channel: channelId || body.user.id,
      text: `\n\`\`\`\n${preview}\n\`\`\`\n`,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  } catch (error) {
    console.error("Error posting final chart:", error);
  }
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ Emoji Encoder is running!");
})();
