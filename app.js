import pkg from "@slack/bolt";
const { App } = pkg;
import stringWidth from "string-width";
import moment from "moment";
import 'dotenv/config';

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
  const hasGeneralCategorical = getGeneralCategoricalColumns(headers, rows).length > 0;
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

  // Store chartType and chartTitle in private_metadata for next view
  const oldMetadata = JSON.parse(view.private_metadata || "{}");
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
      value: "none"
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
              options: quantOptions.length > 0 ? [...quantOptions, noneOption] : [noneOption],
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
          }
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

// simple emoji recommendation function (stand in for backend integration)
function recommendEmojis(columnName) {
  const name = columnName.toLowerCase();

  if (name.includes("city"))
    return [{ emoji: "🏙️" }, { emoji: "🌆" }, { emoji: "🗼" }];

  if (name.includes("revenue"))
    return [{ emoji: "💰" }, { emoji: "💵" }, { emoji: "💲" }];

  if (name.includes("population"))
    return [{ emoji: "👥" }, { emoji: "🧑‍🤝‍🧑" }, { emoji: "👨‍👩‍👧‍👦" }];

  if (name.includes("apple"))
    return [{ emoji: "🍎" }, { emoji: "🍏" }, { emoji: "🥧" }];
  if (name.includes("banana"))
    return [{ emoji: "🍌" }, { emoji: "🐒" }, { emoji: "🌴" }];
  if (name.includes("peach"))
    return [{ emoji: "🍑" }, { emoji: "☀️" }, { emoji: "🌸" }];
  if (name.includes("pear"))
    return [{ emoji: "🍐" }, { emoji: "🌿" }, { emoji: "🍯" }];
  if (name.includes("cherries"))
    return [{ emoji: "🍒" }, { emoji: "❤️" }, { emoji: "🌸" }];
  if (name.includes("strawberries"))
    return [{ emoji: "🍓" }, { emoji: "🍰" }, { emoji: "🍹" }];


  if (name.includes("customer growth"))
    return [{ emoji: "📈" }, { emoji: "👤" }, { emoji: "🌱" }];

  if (name.includes("satisfaction") || name.includes("satisfaction score"))
    return [{ emoji: "😊" }, { emoji: "👍" }, { emoji: "⭐" }];

  return [{ emoji: "🔹" }, { emoji: "🔸" }, { emoji: "🔺" }];
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
  showEmojiAtEnd = false // if true, the value emoji will only be shown at the end
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
  "show_end_emoji_checkbox"
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
      showEmojiAtEnd
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

  // Get recommended emojis
  const labelEmojis = recommendEmojis(labelCol);
  const valueEmojis = recommendEmojis(valueCol);

  // Prepare preview (initial, no emoji for label, first value emoji, no legend)
  // Parse data
  const lines = rawTableData.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = lines
    .slice(1)
    .map((line) => line.split(",").map((cell) => cell.trim()));
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
    showEmojiAtEnd
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
                text: { type: "plain_text", text: "Show emoji only at the end" },
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

    const labelEmoji =
      state.label_emoji_block_svc?.label_emoji_svc?.selected_option?.value ||
      "";

    const lowEmoji =
      state.low_emoji_block_svc?.low_emoji_svc?.selected_option?.value || "👎";

    const mediumEmoji =
      state.medium_emoji_block_svc?.medium_emoji_svc?.selected_option?.value ||
      "😐";

    const highEmoji =
      state.high_emoji_block_svc?.high_emoji_svc?.selected_option?.value ||
      "👍";

    const showLegend =
      state.show_legend_block_svc?.show_legend_svc?.selected_options?.some(
        (opt) => opt.value === "show"
      ) || false;

    const showTitle =
      state.show_title_block_svc?.show_title_checkbox_svc?.selected_options?.some(
        (opt) => opt.value === "show"
      ) ?? true;

    // Parse and aggregate
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

    const preview = generateSingleValueChartPreview({
      agg,
      labelEmoji,
      lowEmoji,
      mediumEmoji,
      highEmoji,
      showLabelEmoji: !(labelEmoji === "none"),
      showLegend,
      minRange,
      maxRange,
      chartTitle,
      showTitle,
    });

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

  const labelEmojis = recommendEmojis(labelCol);
  const valueEmojis = recommendEmojis(valueCol);

  const labelEmoji = "none";
  const lowEmoji = valueEmojis[0]?.emoji || "👎";
  const mediumEmoji = valueEmojis[1]?.emoji || "😐";
  const highEmoji = valueEmojis[2]?.emoji || "👍";
  const showTitle = true;
  const showLegend = false;
  const showLabelEmoji = false;

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

  const new_private_metadata = JSON.stringify({
    ...private_metadata,
    labelCol,
    valueCol,
    minRange,
    maxRange,
    preview,
  });

  await ack({
    response_action: "push",
    view: {
      type: "modal",
      callback_id: "post_final_message",
      private_metadata: new_private_metadata,
      title: { type: "plain_text", text: "Single Value Chart", emoji: true },
      submit: { type: "plain_text", text: "Finish", emoji: true },
      close: { type: "plain_text", text: "Back", emoji: true },
      blocks: [
        {
          type: "section",
          block_id: "label_emoji_block_svc",
          text: {
            type: "mrkdwn",
            text: `*Choose emoji for ${labelCol}*`,
          },
          accessory: {
            type: "static_select",
            action_id: "label_emoji_svc",
            options: [
              { text: { type: "plain_text", text: "No label" }, value: "none" },
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
          block_id: "low_emoji_block_svc",
          text: { type: "mrkdwn", text: `*Low value emoji for ${valueCol}*` },
          accessory: {
            type: "static_select",
            action_id: "low_emoji_svc",
            options: valueEmojis.map((e) => ({
              text: { type: "plain_text", text: `${e.emoji}` },
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
          block_id: "medium_emoji_block_svc",
          text: {
            type: "mrkdwn",
            text: `*Medium value emoji for ${valueCol}*`,
          },
          accessory: {
            type: "static_select",
            action_id: "medium_emoji_svc",
            options: valueEmojis.map((e) => ({
              text: { type: "plain_text", text: `${e.emoji}` },
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
          block_id: "high_emoji_block_svc",
          text: { type: "mrkdwn", text: `*High value emoji for ${valueCol}*` },
          accessory: {
            type: "static_select",
            action_id: "high_emoji_svc",
            options: valueEmojis.map((e) => ({
              text: { type: "plain_text", text: `${e.emoji}` },
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
          block_id: "show_title_block_svc",
          text: { type: "mrkdwn", text: "*Show chart title?*" },
          accessory: {
            type: "checkboxes",
            action_id: "show_title_checkbox_svc",
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
          block_id: "show_legend_block_svc",
          text: { type: "mrkdwn", text: "*Show legend?*" },
          accessory: {
            type: "checkboxes",
            action_id: "show_legend_svc",
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
          block_id: "preview_label_block_svc",
          text: { type: "mrkdwn", text: "*Preview*" },
        },
        {
          type: "section",
          block_id: "preview_block_svc",
          text: {
            type: "mrkdwn",
            text: "```\n" + preview + "\n```",
          },
        },
      ],
    },
  });
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

    const labelEmoji =
      state.label_emoji_block_tc?.label_emoji_tc?.selected_option?.value ||
      "none";
    const showLabelEmoji = labelEmoji !== "none";

    const lowEmoji =
      state.low_emoji_block_tc?.low_emoji_tc?.selected_option?.value || "📉";
    const mediumEmoji =
      state.medium_emoji_block_tc?.medium_emoji_tc?.selected_option?.value ||
      "😐";
    const highEmoji =
      state.high_emoji_block_tc?.high_emoji_tc?.selected_option?.value || "📈";

    const showLegend =
      state.show_legend_block_tc?.show_legend_tc?.selected_options?.some(
        (opt) => opt.value === "show"
      ) || false;

    const showTitle =
      state.show_title_block_tc?.show_title_checkbox_tc?.selected_options?.some(
        (opt) => opt.value === "show"
      ) ?? true;

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

  const labelEmojis = recommendEmojis(labelCol);
  const valueEmojis = recommendEmojis(valueCol);

  const labelEmoji = "none";
  const lowEmoji = valueEmojis[0]?.emoji || "📉";
  const mediumEmoji = valueEmojis[1]?.emoji || "😐";
  const highEmoji = valueEmojis[2]?.emoji || "📈";
  const showTitle = true;
  const showLegend = false;
  const showLabelEmoji = false;

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

  const new_private_metadata = JSON.stringify({
    ...private_metadata,
    labelCol,
    valueCol,
    minRange,
    maxRange,
    preview,
  });

  await ack({
    response_action: "push",
    view: {
      type: "modal",
      callback_id: "post_final_message",
      private_metadata: new_private_metadata,
      title: { type: "plain_text", text: "Trend Chart", emoji: true },
      submit: { type: "plain_text", text: "Finish", emoji: true },
      close: { type: "plain_text", text: "Back", emoji: true },
      blocks: [
        {
          type: "section",
          block_id: "label_emoji_block_tc",
          text: {
            type: "mrkdwn",
            text: `*Choose emoji for ${labelCol}*`,
          },
          accessory: {
            type: "static_select",
            action_id: "label_emoji_tc",
            options: [
              { text: { type: "plain_text", text: "No label" }, value: "none" },
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
          block_id: "low_emoji_block_tc",
          text: { type: "mrkdwn", text: `*Low value emoji for ${valueCol}*` },
          accessory: {
            type: "static_select",
            action_id: "low_emoji_tc",
            options: valueEmojis.map((e) => ({
              text: { type: "plain_text", text: `${e.emoji}` },
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
          block_id: "medium_emoji_block_tc",
          text: {
            type: "mrkdwn",
            text: `*Medium value emoji for ${valueCol}*`,
          },
          accessory: {
            type: "static_select",
            action_id: "medium_emoji_tc",
            options: valueEmojis.map((e) => ({
              text: { type: "plain_text", text: `${e.emoji}` },
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
          block_id: "high_emoji_block_tc",
          text: { type: "mrkdwn", text: `*High value emoji for ${valueCol}*` },
          accessory: {
            type: "static_select",
            action_id: "high_emoji_tc",
            options: valueEmojis.map((e) => ({
              text: { type: "plain_text", text: `${e.emoji}` },
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
          block_id: "preview_label_block_tc",
          text: { type: "mrkdwn", text: "*Preview*" },
        },
        {
          type: "section",
          block_id: "preview_block_tc",
          text: {
            type: "mrkdwn",
            text: "```\n" + preview + "\n```",
          },
        },
      ],
    },
  });
});


// PROPORTION CHART //
function generateProportionChartPreview({
  agg, // aggregated data where each element is in the form of ["labelname", count]
  emojiMap, // recommended emoji map in the form of { "labelname": emoji }; should only pertain to top 5 labels
  chartTitle,
  numEmojisPerLine = 10,
  showTitle = true,
  showLegend = true,
  defaultEmoji = "📦"
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
    const slotCount = Math.max(Math.round((count / frequencySum) * totalSlots), 1);
    emojiSlots.push(...Array(slotCount).fill(emoji));
  }

  // fill remaining space 
  if (emojiSlots.length < totalSlots) {
    emojiSlots.push(...Array(totalSlots - emojiSlots.length).fill(defaultEmoji));
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
      .map(([label]) => `${emojiMap[label.toLowerCase()] || defaultEmoji} = ${label}`)
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
          const labelText = view.blocks.find(b => b.block_id === blockId)?.text?.text;
          const selected = block[actionId]?.selected_option?.value;
          if (labelText && selected) {
            emojiMap[labelText.toLowerCase()] = selected;
          }
        }
      });
    });

    const showLegend =
      state.show_legend_block_por?.show_legend_por?.selected_options?.some(opt => opt.value === "show") || false;

    const showTitle =
      state.show_title_block_por?.show_title_checkbox_por?.selected_options?.some(opt => opt.value === "show") ?? true;


    // parse CSV data
    const lines = rawTableData.trim().split("\n");
    const headers = lines[0].split(",").map((h) => h.trim());
    const rows = lines
      .slice(1)
      .map((line) => line.split(",").map((cell) => cell.trim()));

    const labelIdx = headers.indexOf(labelCol);

    // count frequency of each label
    const agg = {};

    if (freqCol !== "none") { // use frequency specified by the frequency column if selected
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

    } else { // else, use the count of each unique label
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
        Number(state.num_emojis_per_line_block?.num_emojis_per_line_input?.value) || 10,
    });

    // Update preview block
    const blocks = [...view.blocks];
    const previewIdx = blocks.findIndex((b) => b.block_id === "preview_block_por");
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

    const labelCol = view.state.values.value_column_block.value_column.selected_option.value;
    const freqCol = view.state.values.numeric_column_block.numeric_column.selected_option.value;

    // parse CSV data
    const lines = rawTableData.trim().split("\n");
    const headers = lines[0].split(",").map((h) => h.trim());
    const rows = lines
      .slice(1)
      .map((line) => line.split(",").map((cell) => cell.trim()));

    const labelIdx = headers.indexOf(labelCol);

    // count frequency of each label
    const agg = {};

    if (freqCol !== "none") { // use frequency specified by the frequency column if selected
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

    } else { // else, use the count of each unique label
      rows.forEach((row) => {
        const rawLabel = row[labelIdx]?.trim() || "unknown";
        const key = rawLabel.toLowerCase();
        agg[key] = (agg[key] || 0) + 1;
      });
    }


    // take top 5 labels only for emoji mapping
    const sortedLabels = Object.entries(agg).sort((a, b) => b[1] - a[1]);
    const topFive = sortedLabels.slice(0, 5).map(([label]) => label);

    // create emoji map only for top 5
    const emojiMap = {};
    topFive.forEach((label) => {
      const suggestions = recommendEmojis(label);
      emojiMap[label] = suggestions[0]?.emoji || "❓";
    });

    // default settings
    const showTitle = true;
    const showLegend = true;
    const numEmojisPerLine = Number(view.state.values.num_emojis_per_line_block?.num_emojis_per_line_input?.value) || 10;

    // generate preview
    const formattedPreview = generateProportionChartPreview({
      agg,
      emojiMap,
      chartTitle,
      showTitle,
      showLegend,
      numEmojisPerLine
    });

    const new_private_metadata = JSON.stringify({
      ...private_metadata,
      labelCol,
      preview: formattedPreview,
      emojiMap,
      freqCol
    });

    await ack({
      response_action: "push",
      view: {
        type: "modal",
        callback_id: "post_final_message",
        private_metadata: new_private_metadata,
        title: { type: "plain_text", text: "Emoji Chart Builder", emoji: true },
        submit: { type: "plain_text", text: "Finish", emoji: true },
        close: { type: "plain_text", text: "Back", emoji: true },
        blocks: [
          {
            type: "section",
            block_id: "label_emoji_block_por",
            text: {
              type: "mrkdwn",
              text: `*Choose emoji for each unique value in the label column (${labelCol})*`,
            },
          },
          // Create one block per top label
          ...topFive.map((label, i) => ({
            type: "section",
            block_id: `label_emoji_block_${i}`,
            text: {
              type: "mrkdwn",
              text: `${label}`,
            },
            accessory: {
              type: "static_select",
              action_id: `por_label_emoji_${i}`,
              options: recommendEmojis(label).map((e) => ({
                text: { type: "plain_text", text: e.emoji },
                value: e.emoji,
              })),
              initial_option: {
                text: { type: "plain_text", text: emojiMap[label] },
                value: emojiMap[label],
              },
            },
          })),
          {
            type: "section",
            block_id: "show_title_block_por",
            text: {
              type: "mrkdwn",
              text: "*Show chart title?*",
            },
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
                ? [{ text: { type: "plain_text", text: "Show chart title" }, value: "show" }]
                : [],
            },
          },
          {
            type: "section",
            block_id: "show_legend_block_por",
            text: {
              type: "mrkdwn",
              text: "*Show legend?*",
            },
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
                ? [{ text: { type: "plain_text", text: "Show legend" }, value: "show" }]
                : [],
            },
          },
          {
            type: "section",
            block_id: "preview_label_block_por",
            text: {
              type: "mrkdwn",
              text: "*Preview*",
            },
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
