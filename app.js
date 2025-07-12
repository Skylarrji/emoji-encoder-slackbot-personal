const { App } = require("@slack/bolt");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const emojiOptions = (emojis) =>
  emojis.map((e) => ({
    text: { type: "plain_text", text: e },
    value: e,
  }));

const walkScoreEmojis = emojiOptions(["🚗", "🚴", "🚶‍♂️"]);
const bikeScoreEmojis = emojiOptions(["🚫", "🚲", "🚴‍♂️"]);
const regionEmojis = emojiOptions(["🗽", "🚜", "🌊"]);

app.command("/emojichart", async ({ ack, body, client }) => {
  await ack();

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "emoji_chart_modal",
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

// Add a handler for table input changes to update the warning live
app.action("table_input", async ({ body, ack, client }) => {
  await ack();
  const rawTableData = body.actions[0].value;
  const blocks = buildFirstModalBlocks(rawTableData);
  await client.views.update({
    view_id: body.view.id,
    hash: body.view.hash,
    view: {
      type: "modal",
      callback_id: body.view.callback_id,
      title: body.view.title,
      submit: body.view.submit,
      close: body.view.close,
      blocks,
    },
  });
});

// Add action handler for insight selection
app.action("insight_input", async ({ body, ack, client }) => {
  console.log("insight_input action triggered");
  console.log("Selected value:", body.actions[0].selected_option.value);
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
  const { headers, rows } = parseTableData(rawTableData);
  const hasCategorical = getCategoricalColumns(headers, rows).length > 0;
  const hasQuantitative = getQuantitativeColumns(headers, rows).length > 0;

  if (!hasCategorical || !hasQuantitative) {
    await ack({
      response_action: "errors",
      errors: {
        table_data_block:
          "Your data must have at least one categorical column (≤5 unique values) and one numeric column for a bar chart.",
      },
    });
    return;
  }

  const chartType =
    view.state.values.chart_type_block?.chart_type_input?.selected_option
      ?.value;
  // Store chartType in private_metadata for next view
  const private_metadata = JSON.stringify({ rawTableData, chartType });

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
        private_metadata,
        title: { type: "plain_text", text: "Bar Chart Setup", emoji: true },
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

app.view("emoji_chart_finalize", async ({ ack }) => {
  await ack({
    response_action: "push",
    view: {
      type: "modal",
      callback_id: "emoji_customization_modal",
      title: { type: "plain_text", text: "Customize Emojis", emoji: true },
      submit: { type: "plain_text", text: "Preview", emoji: true },
      close: { type: "plain_text", text: "Back", emoji: true },
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Emoji recommendations*" },
        },

        // Walk Score
        { type: "section", text: { type: "mrkdwn", text: "*Walk Score*" } },
        ...["low", "medium", "high"].map((level, i) => ({
          type: "input",
          block_id: `walk_score_${level}`,
          label: {
            type: "plain_text",
            text: `${level.charAt(0).toUpperCase() + level.slice(1)}`,
          },
          element: {
            type: "static_select",
            action_id: "walk_score_select",
            placeholder: { type: "plain_text", text: "Choose emoji" },
            options: walkScoreEmojis,
            initial_option: walkScoreEmojis[i],
          },
        })),

        // Bike Score
        { type: "section", text: { type: "mrkdwn", text: "*Bike Score*" } },
        ...["low", "medium", "high"].map((level, i) => ({
          type: "input",
          block_id: `bike_score_${level}`,
          label: {
            type: "plain_text",
            text: `${level.charAt(0).toUpperCase() + level.slice(1)}`,
          },
          element: {
            type: "static_select",
            action_id: "bike_score_select",
            placeholder: { type: "plain_text", text: "Choose emoji" },
            options: bikeScoreEmojis,
            initial_option: bikeScoreEmojis[i],
          },
        })),

        // Toggle for legend below label columns
        {
          type: "input",
          optional: true,
          block_id: "show_legend_score",
          label: {
            type: "plain_text",
            text: "Show legend below chart for label columns",
          },
          element: {
            type: "checkboxes",
            action_id: "legend_score",
            options: [
              {
                text: { type: "plain_text", text: "Show legend below chart" },
                value: "show",
              },
            ],
          },
        },

        // Region section
        { type: "section", text: { type: "mrkdwn", text: "*Region*" } },
        ...["northeast", "midwest", "northwest"].map((region, i) => ({
          type: "input",
          block_id: `region_${region}`,
          label: {
            type: "plain_text",
            text: `${region.charAt(0).toUpperCase() + region.slice(1)}`,
          },
          element: {
            type: "static_select",
            action_id: "region_select",
            placeholder: { type: "plain_text", text: "Choose emoji" },
            options: regionEmojis,
            initial_option: regionEmojis[i],
          },
        })),

        // Toggle for legend below value columns
        {
          type: "input",
          optional: true,
          block_id: "show_legend_region",
          label: {
            type: "plain_text",
            text: "Show legend below chart for value columns",
          },
          element: {
            type: "checkboxes",
            action_id: "legend_region",
            options: [
              {
                text: { type: "plain_text", text: "Show legend below chart" },
                value: "show",
              },
            ],
          },
        },
        {
          type: "input",
          block_id: "preview_rich_text_block",
          label: {
            type: "plain_text",
            text: "Emoji Chart Preview (editable)",
            emoji: true,
          },
          element: {
            type: "plain_text_input",
            action_id: "preview_rich_text_input",
            multiline: true,
            initial_value: `🌊  🚗 🚴‍♂️ LAX\n🌊 🛴 🚴‍♂️ SFO\n🚜 🚶🚲 CHI`,
          },
        },
      ],
    },
  });
});

app.view("emoji_customization_modal", async ({ ack, body, view, client }) => {
  await ack({ response_action: "clear" });
  const user = body.user.id;

  const walkBikeLevels = ["low", "medium", "high"];
  const walkBikeEmojis = walkBikeLevels
    .map((level) => {
      const walk =
        view.state.values[`walk_score_${level}`]?.walk_score_select
          ?.selected_option?.text?.text || "";
      const bike =
        view.state.values[`bike_score_${level}`]?.bike_score_select
          ?.selected_option?.text?.text || "";
      return `• *${
        level.charAt(0).toUpperCase() + level.slice(1)
      }*: Walk ${walk}, Bike ${bike}`;
    })
    .join("\n");

  const regions = ["northeast", "midwest", "northwest"];
  const regionEmojisText = regions
    .map((region) => {
      const emoji =
        view.state.values[`region_${region}`]?.region_select?.selected_option
          ?.text?.text || "";
      return `• *${
        region.charAt(0).toUpperCase() + region.slice(1)
      }*: ${emoji}`;
    })
    .join("\n");

  const legendScore =
    view.state.values.show_legend_score?.legend_score?.selected_options
      ?.length > 0;
  const legendRegion =
    view.state.values.show_legend_region?.legend_region?.selected_options
      ?.length > 0;

  try {
    await client.chat.postMessage({
      channel: user,
      text: `*Emoji Chart Configuration Preview:*\n\n*Walk/Bike Score Emojis:*\n${walkBikeEmojis}\n\n*Region Emojis:*\n${regionEmojisText}\n\n*Show Legends:*\n• Label Legend: ${
        legendScore ? "Yes" : "No"
      }\n• Value Legend: ${legendRegion ? "Yes" : "No"}`,
    });
  } catch (error) {
    console.error(error);
  }
});

// Add a simple emoji recommendation function
function recommendEmojis(columnName) {
  const name = columnName.toLowerCase();
  if (name.includes("city"))
    return [
      { emoji: "🏙️", label: "City" },
      { emoji: "🌆", label: "Cityscape" },
      { emoji: "🗼", label: "Tower" },
    ];
  if (name.includes("revenue"))
    return [
      { emoji: "💰", label: "Money Bag" },
      { emoji: "💵", label: "Dollar Bills" },
      { emoji: "💲", label: "Dollar Sign" },
    ];
  if (name.includes("population"))
    return [
      { emoji: "👥", label: "People" },
      { emoji: "🧑‍🤝‍🧑", label: "Group" },
      { emoji: "👨‍👩‍👧‍👦", label: "Family" },
    ];
  // fallback
  return [
    { emoji: "🔹", label: "Blue Diamond" },
    { emoji: "🔸", label: "Orange Diamond" },
    { emoji: "🔺", label: "Red Triangle" },
  ];
}

// Handler for bar_chart_column_select submission
app.view("bar_chart_column_select", async ({ ack, view, body, client }) => {
  const private_metadata = JSON.parse(view.private_metadata || "{}");
  const rawTableData = private_metadata.rawTableData;
  const chartType = private_metadata.chartType;
  const labelCol =
    view.state.values.label_column_block.label_column.selected_option.value;
  const valueCol =
    view.state.values.value_column_block.value_column.selected_option.value;

  // Get recommended emojis
  const labelEmojis = recommendEmojis(labelCol);
  const valueEmojis = recommendEmojis(valueCol);

  // Prepare preview (initial, no emoji for label, first emoji for value)
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
  // Sort by value descending
  const sorted = Object.entries(agg).sort((a, b) => b[1] - a[1]);
  // Find max label length for padding
  const maxLabelLen = Math.max(...sorted.map(([label]) => label.length));
  // Default preview: no label emoji, first value emoji, no legend
  const valueEmoji = valueEmojis[0].emoji;
  let preview = sorted
    .map(([label, val]) => {
      const padded = label.padEnd(maxLabelLen, " ");
      return `${padded} ${
        valueEmoji.repeat(Math.round(val / 10)) || valueEmoji
      }`;
    })
    .join("\n");

  await ack({
    response_action: "push",
    view: {
      type: "modal",
      callback_id: "bar_chart_emoji_customize",
      private_metadata: JSON.stringify({
        rawTableData,
        chartType,
        labelCol,
        valueCol,
      }),
      title: { type: "plain_text", text: "Bar Chart Emojis", emoji: true },
      submit: { type: "plain_text", text: "Finish", emoji: true },
      close: { type: "plain_text", text: "Back", emoji: true },
      blocks: [
        {
          type: "input",
          block_id: "show_label_emoji_block",
          optional: true,
          label: { type: "plain_text", text: "Show emoji next to label?" },
          element: {
            type: "checkboxes",
            action_id: "show_label_emoji",
            options: [
              {
                text: { type: "plain_text", text: "Show emoji for label" },
                value: "show",
              },
            ],
          },
        },
        {
          type: "input",
          block_id: "label_emoji_block",
          optional: true,
          label: { type: "plain_text", text: `Choose emoji for ${labelCol}` },
          element: {
            type: "static_select",
            action_id: "label_emoji",
            options: labelEmojis.map((e) => ({
              text: { type: "plain_text", text: `${e.emoji} ${e.label}` },
              value: e.emoji,
            })),
          },
        },
        {
          type: "input",
          block_id: "value_emoji_block",
          label: { type: "plain_text", text: `Choose emoji for ${valueCol}` },
          element: {
            type: "static_select",
            action_id: "value_emoji",
            options: valueEmojis.map((e) => ({
              text: { type: "plain_text", text: `${e.emoji} ${e.label}` },
              value: e.emoji,
            })),
          },
        },
        {
          type: "input",
          block_id: "show_legend_block",
          optional: true,
          label: { type: "plain_text", text: "Show legend?" },
          element: {
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
          type: "input",
          block_id: "preview_block",
          label: { type: "plain_text", text: "Preview", emoji: true },
          element: {
            type: "plain_text_input",
            action_id: "preview_input",
            multiline: true,
            initial_value: preview,
          },
        },
      ],
    },
  });
});

// Helper to generate the bar chart preview
function generateBarChartPreview({
  agg,
  labelEmoji,
  valueEmoji,
  showLabelEmoji,
  showLegend,
  labelCol,
  valueCol,
  legendLabel,
}) {
  const sorted = Object.entries(agg).sort((a, b) => b[1] - a[1]);
  const maxLabelLen = Math.max(...sorted.map(([label]) => label.length));
  let preview = sorted
    .map(([label, val]) => {
      const padded = label.padEnd(maxLabelLen, " ");
      const labelPart = showLabelEmoji && labelEmoji ? `${labelEmoji} ` : "";
      return `${labelPart}${padded} ${
        valueEmoji.repeat(Math.round(val / 10)) || valueEmoji
      }`;
    })
    .join("\n");
  if (showLegend && valueEmoji) {
    preview += `\nlegend: ${valueEmoji} = ${legendLabel || valueCol}`;
  }
  return preview;
}

// Add action handlers for live preview updates in bar_chart_emoji_customize
const barChartEmojiActions = [
  "show_label_emoji",
  "label_emoji",
  "value_emoji",
  "show_legend",
];
barChartEmojiActions.forEach((actionId) => {
  app.action(actionId, async ({ body, ack, client }) => {
    await ack();
    const view = body.view;
    const state = view.state.values;
    const private_metadata = JSON.parse(view.private_metadata || "{}");
    const rawTableData = private_metadata.rawTableData;
    const labelCol = private_metadata.labelCol;
    const valueCol = private_metadata.valueCol;
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
    // Get current selections
    const showLabelEmoji =
      state.show_label_emoji_block?.show_label_emoji?.selected_options?.some(
        (opt) => opt.value === "show"
      );
    const labelEmoji =
      state.label_emoji_block?.label_emoji?.selected_option?.value || "";
    const valueEmoji =
      state.value_emoji_block?.value_emoji?.selected_option?.value ||
      recommendEmojis(valueCol)[0].emoji;
    const showLegend =
      state.show_legend_block?.show_legend?.selected_options?.some(
        (opt) => opt.value === "show"
      );
    const legendLabel = valueCol;
    // Generate preview
    const preview = generateBarChartPreview({
      agg,
      labelEmoji,
      valueEmoji,
      showLabelEmoji,
      showLegend,
      labelCol,
      valueCol,
      legendLabel,
    });
    // Update the modal
    const blocks = [...view.blocks];
    // Find preview block and update its initial_value
    const previewIdx = blocks.findIndex((b) => b.block_id === "preview_block");
    if (previewIdx !== -1) {
      blocks[previewIdx] = {
        ...blocks[previewIdx],
        element: {
          ...blocks[previewIdx].element,
          initial_value: preview,
        },
      };
    }
    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: {
        ...view,
        blocks,
      },
    });
  });
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ Emoji Encoder is running!");
})();
