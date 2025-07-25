import pkg from "@slack/bolt";
const { App } = pkg;
import stringWidth from "string-width";

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
  return headers.filter((col, idx) => {
    const values = rows.map((row) => row[idx]);
    const unique = Array.from(new Set(values));
    const allNumeric = unique.every((v) => !isNaN(Number(v)));
    return unique.length <= 5 && !allNumeric;
  });
};

const getQuantitativeColumns = (headers, rows) => {
  // Quantitative: all values numeric
  return headers.filter((col, idx) => {
    const values = rows.map((row) => row[idx]);
    return values.every((v) => v !== "" && !isNaN(Number(v)));
  });
};

app.view("emoji_chart_modal", async ({ ack, view, body, client }) => {
  const rawTableData = view.state.values.table_data_block.table_input.value;
  const chartTitle =
    view.state.values.chart_title_block.chart_title_input.value;

  const { headers, rows } = parseTableData(rawTableData);
  const hasCategorical = getCategoricalColumns(headers, rows).length > 0;
  const hasQuantitative = getQuantitativeColumns(headers, rows).length > 0;

  if (!hasCategorical || !hasQuantitative) {
    await ack({
      response_action: "errors",
      errors: {
        table_data_block:
          "Your data must have at least one categorical column (with at most 5 unique values) and one numeric column.",
      },
    });
    return;
  }

  const chartType =
    view.state.values.chart_type_block?.chart_type_input?.selected_option
      ?.value;

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
  if (name.includes("population")) {
    return [{ emoji: "👥" }, { emoji: "🧑‍🤝‍🧑" }, { emoji: "👨‍👩‍👧‍👦" }];
  }
  // fallback
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

      return `${paddedLabel}  ${valueEmoji.repeat(emojiCount)}`;
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

    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: {
        type: view.type,
        title: view.title,
        blocks: blocks,
        callback_id: view.callback_id,
        private_metadata: view.private_metadata,
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
  });

  const new_private_metadata = JSON.stringify({
    ...private_metadata,
    preview
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

  // auto-calculate thresholds if user input is not given
  const values = entries.map(([, val]) => val).sort((a, b) => a - b);
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
  "low_threshold_svc",
  "high_threshold_svc",
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

    const labelEmoji =
      state.label_emoji_block_svc?.label_emoji_svc?.selected_option?.value || "";

    const lowEmoji =
      state.low_emoji_block_svc?.low_emoji_svc?.selected_option?.value || "👎";

    const mediumEmoji =
      state.medium_emoji_block_svc?.medium_emoji_svc?.selected_option?.value || "😐";

    const highEmoji =
      state.high_emoji_block_svc?.high_emoji_svc?.selected_option?.value || "👍";

    const showLegend =
      state.show_legend_block_svc?.show_legend_svc?.selected_options?.some(
        (opt) => opt.value === "show"
      ) || false;

    const showTitle =
      state.show_title_block_svc?.show_title_checkbox_svc?.selected_options?.some(
        (opt) => opt.value === "show"
      ) ?? true;

    const lowThreshold = Number(state.low_threshold_block_svc?.low_threshold_svc?.value || "");
    const highThreshold = Number(state.high_threshold_block_svc?.high_threshold_svc?.value || "");

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
      lowThreshold: isNaN(lowThreshold) ? undefined : lowThreshold,
      highThreshold: isNaN(highThreshold) ? undefined : highThreshold,
      chartTitle,
      showTitle,
    });

    const blocks = [...view.blocks];
    const previewIdx = blocks.findIndex((b) => b.block_id === "preview_block_svc");
    if (previewIdx !== -1) {
      blocks[previewIdx] = {
        ...blocks[previewIdx],
        text: {
          type: "mrkdwn",
          text: "```\n" + preview + "\n```",
        },
      };
    }

    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: {
        type: view.type,
        title: view.title,
        blocks,
        callback_id: view.callback_id,
        private_metadata: view.private_metadata,
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

  const lowStr = view.state.values.value_range_low_block?.value_range_low_input?.value;
  const highStr = view.state.values.value_range_high_block?.value_range_high_input?.value;

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
    showLabelEmoji: false,
    showLegend,
    minRange,
    maxRange,
    chartTitle,
    showTitle,
  });

  const new_private_metadata = JSON.stringify({
    ...private_metadata,
    preview
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
          text: { type: "mrkdwn", text: `*Medium value emoji for ${valueCol}*` },
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
    console.error("Error posting single value chart:", error);
  }
});



(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ Emoji Encoder is running!");
})();
