const { App } = require('@slack/bolt');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// first modal opened with /emojichart
app.command('/emojichart', async ({ ack, body, client }) => {
  await ack(); 

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'emoji_chart_modal',
        title: {
          type: 'plain_text',
          text: 'Create Emoji Chart',
          emoji: true
        },
        submit: {
          type: 'plain_text',
          text: 'Next',
          emoji: true
        },
        close: {
          type: 'plain_text',
          text: 'Cancel',
          emoji: true
        },
        blocks: [
          {
            type: 'input',
            block_id: 'chart_title_block',
            label: {
              type: 'plain_text',
              text: 'Chart title',
              emoji: true
            },
            element: {
              type: 'plain_text_input',
              action_id: 'chart_title_input',
              placeholder: {
                type: 'plain_text',
                text: 'Transportation in different cities'
              }
            }
          },
          {
            type: 'section',
            block_id: 'upload_file_info',
            text: {
              type: 'mrkdwn',
              text: '*Example table input:*\n```\nPopulation,Place,Bike Score\n614664,BWI,56\n```'
            }
          },
          {
            type: 'input',
            block_id: 'table_data_block',
            label: {
              type: 'plain_text',
              text: 'Paste table data here',
              emoji: true
            },
            element: {
              type: 'plain_text_input',
              multiline: true,
              action_id: 'table_input',
              placeholder: {
                type: 'plain_text',
                text: 'e.g. Population,Place,Bike Score'
              }
            }
          },
          {
            type: 'input',
            block_id: 'insight_block',
            label: {
              type: 'plain_text',
              text: 'What insight do you want to communicate?',
              emoji: true
            },
            element: {
              type: 'radio_buttons',
              action_id: 'insight_input',
              options: [
                {
                  text: { type: 'plain_text', text: 'Wrapped Proportional Unit Array' },
                  value: 'wrapped_unit_array'
                },
                {
                  text: { type: 'plain_text', text: 'Univariate Time Series' },
                  value: 'univariate_time_series'
                },
                {
                  text: { type: 'plain_text', text: 'Multivariate Emoji Grid' },
                  value: 'multivariate_emoji_grid'
                },
                {
                  text: { type: 'plain_text', text: 'Stacked Horizontal Bar Chart' },
                  value: 'stacked_bar_chart'
                }
              ]
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error(error);
  }
});

// handler for the first modal submission after user clicks next
app.view('emoji_chart_modal', async ({ ack, view }) => {
  // extract table input from first modal submission
  const rawTableData = view.state.values.table_data_block.table_input.value;

  // split table by newlines and commas to get headers
  const lines = rawTableData.trim().split('\n');
  const headers = lines.length > 0 ? lines[0].split(',').map(h => h.trim()) : [];

  // fallback if headers can't be extracted
  const columns = headers.length > 0 ? headers : ['Column 1', 'Column 2'];

  const options = columns.map(col => ({
    text: { type: 'plain_text', text: col },
    value: col.toLowerCase().replace(/ /g, '_')
  }));

  await ack({
    response_action: 'push',
    view: {
      type: 'modal',
      callback_id: 'emoji_chart_finalize',
      title: {
        type: 'plain_text',
        text: 'Create Emoji Chart',
        emoji: true
      },
      submit: {
        type: 'plain_text',
        text: 'Generate',
        emoji: true
      },
      close: {
        type: 'plain_text',
        text: 'Back',
        emoji: true
      },
      blocks: [
        {
          type: 'input',
          block_id: 'label_column_block',
          label: { type: 'plain_text', text: 'Label Columns' },
          element: {
            type: 'multi_static_select',
            action_id: 'label_columns',
            placeholder: {
              type: 'plain_text',
              text: 'Select 1 or more'
            },
            options: options
          }
        },
        {
          type: 'input',
          block_id: 'value_column_block',
          label: { type: 'plain_text', text: 'Value Columns' },
          element: {
            type: 'multi_static_select',
            action_id: 'value_columns',
            placeholder: {
              type: 'plain_text',
              text: 'Select 1 or more'
            },
            options: options
          }
        },
        {
          type: 'input',
          optional: true,
          block_id: 'group_by_block',
          label: { type: 'plain_text', text: 'Group by' },
          element: {
            type: 'static_select',
            action_id: 'group_by',
            placeholder: {
              type: 'plain_text',
              text: 'Select a column'
            },
            options: options
          }
        }
      ]
    }
  });
});

// handler for the final modal submission ("Generate")
app.view('emoji_chart_finalize', async ({ ack, body, view, client }) => {
  await ack({ // force close all modal views
    response_action: 'clear'
  });

  const user = body.user.id;

  const labelCols = view.state.values.label_column_block.label_columns.selected_options.map(opt => opt.text.text);
  const valueCols = view.state.values.value_column_block.value_columns.selected_options.map(opt => opt.text.text);
  const groupBy = view.state.values.group_by_block?.group_by?.selected_option?.text?.text || 'None';

  try {
    await client.chat.postMessage({
      channel: user,
      text: `*Chart Configuration:*\n• *Label Columns:* ${labelCols.join(', ')}\n• *Value Columns:* ${valueCols.join(', ')}\n• *Group By:* ${groupBy}`
    });
  } catch (error) {
    console.error(error);
  }
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Emoji Encoder is running!');
})();
