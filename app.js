const { App } = require('@slack/bolt');

/**
 * This sample slack application uses SocketMode.
 * For the companion getting started setup guide, see:
 * https://tools.slack.dev/bolt-js/getting-started/
 */

// Initializes your app with your bot token and app token
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// initial modal that opens when the user types /emojichart
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
                  text: {
                    type: 'plain_text',
                    text: 'Wrapped Proportional Unit Array'
                  },
                  value: 'wrapped_unit_array'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Univariate Time Series'
                  },
                  value: 'univariate_time_series'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Multivariate Emoji Grid'
                  },
                  value: 'multivariate_emoji_grid'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Stacked Horizontal Bar Chart'
                  },
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


// handles what happens when a user clicks next in the modal
app.view('emoji_chart_modal', async ({ ack, body, view, client }) => {
  await ack();

  const user = body.user.id;
  const tableData = view.state.values.table_data_block.table_input.value;

  // You can send a follow-up message or start next modal here
  try {
    await client.chat.postMessage({
      channel: user,
      text: `Thanks! You submitted:\n\n${tableData}`
    });
  } catch (error) {
    console.error(error);
  }
});


(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Emoji Encoder is running!');
})();

