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
      title: body.view.title,
      submit: body.view.submit,
      close: body.view.close,
      blocks,
    },
  });
});

app.view("emoji_chart_modal", async ({ ack, view }) => {
  const rawTableData = view.state.values.table_data_block.table_input.value;
  const lines = rawTableData.trim().split("\n");
  const headers =
    lines.length > 0 ? lines[0].split(",").map((h) => h.trim()) : [];
  const columns = headers.length > 0 ? headers : ["Column 1", "Column 2"];

  const options = columns.map((col) => ({
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

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ Emoji Encoder is running!");
})();
