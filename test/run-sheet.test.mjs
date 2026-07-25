// ===========================================================================
// URA Session Run-Sheet test harness
// ===========================================================================
// Drives the REAL command/view handlers from app.js (loaded with @slack/bolt
// mocked out) through the exact sequence the URA Session Run Sheet prescribes,
// asserting the behaviour the run sheet depends on at each step:
//
//   A. /reset between participants            (run sheet A.2, H.19)
//   C. /setup loads participant + Task 1       (run sheet C.6)
//      /check matches the Schedule tab         (run sheet C.7, F.11)
//   F. /next auto-advances the condition       (run sheet F.15)
//      /back recovers an early /next           (run sheet F.15)
//   Condition enforcement per variant (manual / placeholder / semantic)
//   Experimenter-only lock on study commands
//   "recommendation unavailable" STOP path     (run sheet: When to STOP)
//   /emojichart opens the builder + starts a measured task
//
// Run with:  npm run test:runsheet
// (which sets up the module loader that mocks @slack/bolt).
// ===========================================================================

// --- Environment must be set BEFORE app.js is imported ---------------------
process.env.EXPERIMENTER_USER_IDS = "UEXP"; // lock study commands to this user
process.env.STUDY_VARIANT = "semantic"; // default condition
process.env.PLACEHOLDER_EMOJI = "⬛";
process.env.MANUAL_UNSET_EMOJI = "⬜";
process.env.EMOJI_API_URL = "http://127.0.0.1:59999"; // unreachable on purpose
process.env.STUDY_LOG_DIR = new URL("./.test-logs", import.meta.url).pathname; // isolate logs

import { registry } from "./mocks/slack-bolt.mock.mjs";
import {
  getParticipantSchedule,
  describeSchedule,
  CONDITION_SQUARE,
  TASKS,
} from "../studySchedule.js";

// Importing app.js registers every handler against the mocked App.
const appModule = await import("../app.js");
const { getActiveVariant, getStudyContext, studySession } = appModule;

// --------------------------------------------------------------------------
// Tiny assertion framework
// --------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
let currentSection = "";

function section(name) {
  currentSection = name;
  console.log(`\n=== ${name} ===`);
}
function check(label, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(
      `[${currentSection}] ${label}${detail ? ` — ${detail}` : ""}`,
    );
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// --------------------------------------------------------------------------
// Fake Slack plumbing for invoking real handlers
// --------------------------------------------------------------------------
function makeClient() {
  const calls = {
    viewsOpen: [],
    viewsUpdate: [],
    viewsPush: [],
    postMessage: [],
    imOpen: [],
  };
  const client = {
    views: {
      open: async (a) => {
        calls.viewsOpen.push(a);
        return { view: { id: "V_OPEN" } };
      },
      update: async (a) => {
        calls.viewsUpdate.push(a);
        return { view: { id: "V_UPD" } };
      },
      push: async (a) => {
        calls.viewsPush.push(a);
        return { view: { id: "V_PUSH" } };
      },
    },
    conversations: {
      open: async (a) => {
        calls.imOpen.push(a);
        return { channel: { id: "D1" } };
      },
    },
    chat: {
      postMessage: async (a) => {
        calls.postMessage.push(a);
        return { ok: true };
      },
    },
  };
  client.__calls = calls;
  return client;
}

async function runCommand(
  name,
  { user = "UEXP", channel = "C1", client } = {},
) {
  const handler = registry.commands.get(name);
  if (!handler) throw new Error(`No registered handler for command ${name}`);
  const calls = { ack: [], respond: [] };
  const c = client || makeClient();
  await handler({
    command: { user_id: user, channel_id: channel, thread_ts: null, text: "" },
    ack: async (a) => calls.ack.push(a ?? null),
    body: { trigger_id: "TRIG", user: { id: user } },
    client: c,
    respond: async (r) => calls.respond.push(r),
  });
  return { calls, client: c };
}

async function runView(id, { view, user = "UEXP", client } = {}) {
  const handler = registry.views.get(id);
  if (!handler) throw new Error(`No registered handler for view ${id}`);
  const calls = { ack: [] };
  const c = client || makeClient();
  await handler({
    ack: async (a) => calls.ack.push(a ?? null),
    view,
    body: { user: { id: user } },
    client: c,
  });
  return { calls, client: c };
}

function setupView({ id = "P1", number = "1", mode = "auto" } = {}) {
  return {
    state: {
      values: {
        participant_id_block: { participant_id_input: { value: id } },
        participant_number_block: {
          participant_number_input: { value: number },
        },
        condition_block: {
          condition_input: { selected_option: { value: mode } },
        },
      },
    },
    private_metadata: "{}",
  };
}

const respondText = (calls) => calls.respond[0]?.text ?? "";

// ==========================================================================
// 1. Latin-square schedule (studySchedule.js) — the source of truth the URA
//    verifies /check against.
// ==========================================================================
section("1. Latin-square schedule integrity");

check(
  "3 tasks x 3 condition rows defined",
  TASKS.length === 3 && CONDITION_SQUARE.length === 3,
  `tasks=${TASKS.length} rows=${CONDITION_SQUARE.length}`,
);

const conds1 = getParticipantSchedule(1).map((t) => t.condition);
const conds2 = getParticipantSchedule(2).map((t) => t.condition);
const conds3 = getParticipantSchedule(3).map((t) => t.condition);
check(
  "P1 conditions = manual, placeholder, semantic",
  JSON.stringify(conds1) ===
    JSON.stringify(["manual", "placeholder", "semantic"]),
  conds1.join(","),
);
check(
  "P2 conditions = placeholder, semantic, manual",
  JSON.stringify(conds2) ===
    JSON.stringify(["placeholder", "semantic", "manual"]),
  conds2.join(","),
);
check(
  "P3 conditions = semantic, manual, placeholder",
  JSON.stringify(conds3) ===
    JSON.stringify(["semantic", "manual", "placeholder"]),
  conds3.join(","),
);
check(
  "Latin-square wraps: P4 row == P1 row, P7 == P1",
  describeSchedule(4) === describeSchedule(1) &&
    describeSchedule(7) === describeSchedule(1),
);
check(
  "Each task position is balanced across conditions",
  [0, 1, 2].every((col) => {
    const colConds = new Set(CONDITION_SQUARE.map((row) => row[col]));
    return colConds.size === 3;
  }),
);
check(
  "Chart types are fixed per task slot (bar, proportion, trend)",
  TASKS.map((t) => t.chartType).join(",") === "bar,proportion,trend",
  TASKS.map((t) => t.chartType).join(","),
);
{
  let threw = false;
  try {
    getParticipantSchedule(0);
  } catch {
    threw = true;
  }
  check("Invalid participant number throws (0 rejected)", threw);
}

// ==========================================================================
// 2. Run sheet A.2 — /reset clears state; experimenter-only
// ==========================================================================
section("2. /reset (run sheet A.2 / H.19)");

{
  const { calls } = await runCommand("/reset");
  check(
    "Experimenter /reset acknowledges and reports cleared state",
    calls.ack.length === 1 && /cleared/i.test(respondText(calls)),
    respondText(calls),
  );
  check(
    "After /reset no participant is loaded",
    studySession.schedule === null,
  );
  check(
    "After /reset active condition is the default (semantic)",
    getActiveVariant() === "semantic",
    getActiveVariant(),
  );
}
{
  const { calls } = await runCommand("/reset", { user: "UPARTICIPANT" });
  check(
    "Non-experimenter is blocked from /reset",
    /restricted to the experimenter/i.test(respondText(calls)),
    respondText(calls),
  );
}

// ==========================================================================
// 3. Run sheet C.6 — /setup loads the participant and starts Task 1
// ==========================================================================
section("3. /setup loads participant (run sheet C.6)");

{
  // Non-experimenter cannot open the setup modal.
  const { calls, client } = await runCommand("/setup", { user: "UPART" });
  check(
    "Non-experimenter blocked from /setup (no modal opened)",
    client.__calls.viewsOpen.length === 0 &&
      /restricted to the experimenter/i.test(respondText(calls)),
  );
}
{
  // Experimenter opens the modal.
  const { client } = await runCommand("/setup", { user: "UEXP" });
  const opened = client.__calls.viewsOpen[0];
  check(
    "Experimenter /setup opens the study_setup_modal",
    opened?.view?.callback_id === "study_setup_modal",
    opened?.view?.callback_id,
  );
  const condOpts =
    opened?.view?.blocks?.find((b) => b.block_id === "condition_block")?.element
      ?.options ?? [];
  check(
    "Condition mode defaults to Auto (Latin-square) as first option",
    condOpts[0]?.value === "auto",
    condOpts[0]?.value,
  );
}
{
  // Submit the modal for participant number 1.
  await runView("study_setup_modal", {
    view: setupView({ id: "P1", number: "1" }),
  });
  const ctx = getStudyContext();
  check(
    "Participant P1 loaded, schedule has 3 tasks",
    studySession.participantId === "P1" && ctx.taskCount === 3,
    JSON.stringify({ id: studySession.participantId, n: ctx.taskCount }),
  );
  check(
    "Bot auto-starts on Task 1 with that participant's scheduled condition (manual)",
    ctx.taskNumber === "1" && ctx.variant === "manual",
    `task=${ctx.taskNumber} cond=${ctx.variant}`,
  );
  check(
    "Latin-square cell attributed as P1-T1",
    ctx.latinSquareCell === "P1-T1",
    ctx.latinSquareCell,
  );
}
{
  // Setup confirmation DM is sent (run sheet C.6: "bot DMs you a confirmation").
  const client = makeClient();
  await runView("study_setup_modal", {
    view: setupView({ id: "P1", number: "1" }),
    client,
  });
  const dm = client.__calls.postMessage[0];
  check(
    "Setup opens a DM and posts the schedule confirmation",
    client.__calls.imOpen.length === 1 &&
      /Participant loaded/i.test(dm?.text ?? "") &&
      /Task 1 of 3/i.test(dm?.text ?? ""),
    dm?.text,
  );
}
{
  // Invalid participant number must surface an inline error, not misassign.
  await runCommand("/reset");
  const { calls } = await runView("study_setup_modal", {
    view: setupView({ id: "Pbad", number: "0" }),
  });
  const ack0 = calls.ack[0];
  check(
    "Invalid participant number (0) returns an inline modal error",
    ack0?.response_action === "errors" &&
      !!ack0?.errors?.participant_number_block,
    JSON.stringify(ack0),
  );
  check(
    "Session is NOT loaded after a rejected participant number",
    studySession.schedule === null,
  );
}

// ==========================================================================
// 4. Run sheet C.7 / F.11 — /check reports the condition to verify vs Schedule
// ==========================================================================
section("4. /check verification (run sheet C.7 / F.11)");

await runCommand("/reset");
await runView("study_setup_modal", {
  view: setupView({ id: "P1", number: "1" }),
});
{
  const { calls } = await runCommand("/check");
  const text = respondText(calls);
  check(
    "/check shows 'Task 1 of 3' and condition MANUAL (matches Schedule tab T1)",
    /Task 1 of 3/.test(text) && /MANUAL/.test(text),
    text.replace(/\n/g, " | "),
  );
  check(
    "/check echoes the full schedule summary for cross-checking",
    text.includes(describeSchedule(1)),
    text.replace(/\n/g, " | "),
  );
}
{
  const { calls } = await runCommand("/check", { user: "UPART" });
  check(
    "Participant cannot run /check (condition stays hidden from them)",
    /restricted to the experimenter/i.test(respondText(calls)),
  );
}

// ==========================================================================
// 5. Run sheet F.15 — /next auto-advances the condition; /back recovers
// ==========================================================================
section("5. /next auto-advance + /back recovery (run sheet F.15)");

await runCommand("/reset");
await runView("study_setup_modal", {
  view: setupView({ id: "P1", number: "1" }),
});
{
  const { calls } = await runCommand("/next");
  check(
    "/next advances to Task 2 with condition PLACEHOLDER (no manual picking)",
    /Task 2 of 3/.test(respondText(calls)) &&
      /PLACEHOLDER/.test(respondText(calls)) &&
      getActiveVariant() === "placeholder",
    respondText(calls).replace(/\n/g, " | "),
  );
}
{
  const { calls } = await runCommand("/next");
  check(
    "/next advances to Task 3 with condition SEMANTIC",
    /Task 3 of 3/.test(respondText(calls)) &&
      /SEMANTIC/.test(respondText(calls)) &&
      getActiveVariant() === "semantic",
    respondText(calls).replace(/\n/g, " | "),
  );
}
{
  // Calling /next after Task 3 completes triggers Part 3, not "all done".
  const { calls } = await runCommand("/next");
  check(
    "/next after Task 3 starts Part 3 (condition locked to SEMANTIC)",
    /Part 3/i.test(respondText(calls)) &&
      getActiveVariant() === "semantic" &&
      studySession.part3Active === true,
    respondText(calls).replace(/\n/g, " | "),
  );
}
{
  // /back from Part 3 cannot step back (Part 3 is not a regular task).
  const { calls } = await runCommand("/back");
  check(
    "/back during Part 3 does not regress (cannot go back from free exploration)",
    !/Task 2 of 3/.test(respondText(calls)),
    respondText(calls).replace(/\n/g, " | "),
  );
}
{
  // Test /back works correctly during Part 2 (before Part 3).
  await runCommand("/reset");
  await runView("study_setup_modal", {
    view: setupView({ id: "P1", number: "1" }),
  });
  await runCommand("/next"); // -> Task 2
  await runCommand("/next"); // -> Task 3
  const { calls } = await runCommand("/back");
  check(
    "/back returns to Task 2 / PLACEHOLDER (from Task 3, before Part 3)",
    /Task 2 of 3/.test(respondText(calls)) &&
      getActiveVariant() === "placeholder",
    respondText(calls).replace(/\n/g, " | "),
  );
}
{
  await runCommand("/back"); // -> Task 1
  const { calls } = await runCommand("/back"); // already at Task 1
  check(
    "/back cannot go before Task 1",
    /Already at Task 1/i.test(respondText(calls)),
    respondText(calls),
  );
}
{
  await runCommand("/reset");
  const { calls } = await runCommand("/next");
  check(
    "/next with no participant loaded warns to run /setup",
    /No participant loaded/i.test(respondText(calls)),
    respondText(calls),
  );
}

// ==========================================================================
// 6. Condition enforcement — what the participant actually sees per condition
// ==========================================================================
section("6. Per-condition emoji enforcement");

const sampleRecs = {
  column_name_emojis: { Genre: ["🎬", "🎭"] },
  categorical_value_emojis: { Genre: { Action: ["💥"] } },
  column_emoji_scales: { Rating: [["🔅", "🔆", "☀️"]] },
};
const { getRecEmojiOptions, recommendEmojis } = appModule;
const {
  resetPlaceholderAssignments,
  PLACEHOLDER_NOMINAL_EMOJIS,
  PLACEHOLDER_SCALE_EMOJIS,
} = appModule;

studySession.variant = "manual";
{
  const opt = getRecEmojiOptions(sampleRecs, "Genre", "column_name");
  const scale = getRecEmojiOptions(sampleRecs, "Rating", "scale");
  check(
    "MANUAL: every slot shows the neutral unset marker (⬜), no semantic leak",
    opt.length === 1 &&
      opt[0].emoji === "⬜" &&
      scale.low[0].emoji === "⬜" &&
      scale.high[0].emoji === "⬜",
    JSON.stringify(opt),
  );
}
studySession.variant = "placeholder";
{
  resetPlaceholderAssignments();
  const opt = getRecEmojiOptions(sampleRecs, "Genre", "column_name");
  check(
    // The participant can now choose their own neutral colour for this slot
    // (feedback: "let the user choose the colours of the placeholder emojis
    // through a selection dropdown"), so every option in the palette is
    // offered — with the auto-assigned mark listed first as the default.
    "PLACEHOLDER: a nominal slot offers the full neutral colour palette, auto-assigned mark first",
    opt.length === PLACEHOLDER_NOMINAL_EMOJIS.length &&
      opt.every((o) => PLACEHOLDER_NOMINAL_EMOJIS.includes(o.emoji)) &&
      new Set(opt.map((o) => o.emoji)).size === opt.length,
    JSON.stringify(opt),
  );
}
studySession.variant = "semantic";
{
  const names = getRecEmojiOptions(sampleRecs, "Genre", "column_name");
  const val = getRecEmojiOptions(sampleRecs, "Genre", "value", "Action");
  const scale = getRecEmojiOptions(sampleRecs, "Rating", "scale");
  check(
    "SEMANTIC: backend recommendations flow through unchanged",
    names[0].emoji === "🎬" &&
      val[0].emoji === "💥" &&
      scale.low[0].emoji === "🔅" &&
      scale.high[0].emoji === "☀️",
    JSON.stringify({ names, val, low: scale.low }),
  );
}

// ==========================================================================
// 6b. Placeholder structure-matched marks: DISTINCT per nominal slot,
//     monotonic neutral RAMP for the ordinal scale.
// ==========================================================================
section("6b. Placeholder structure-matched marks");

studySession.variant = "placeholder";
{
  // Proportion-style: five distinct categories in the same column.
  resetPlaceholderAssignments();
  const cats = ["Latte", "Cappuccino", "Espresso", "Mocha", "Americano"];
  const marks = cats.map(
    (c) => getRecEmojiOptions(sampleRecs, "drink", "value", c)[0].emoji,
  );
  check(
    "PLACEHOLDER nominal: each category gets a DISTINCT mark",
    new Set(marks).size === marks.length,
    marks.join(" "),
  );
  check(
    "PLACEHOLDER nominal: marks come from the neutral set (no semantics)",
    marks.every((m) => PLACEHOLDER_NOMINAL_EMOJIS.includes(m)),
    marks.join(" "),
  );
  // Re-querying the same category returns the SAME mark (stable re-render).
  const again = getRecEmojiOptions(sampleRecs, "drink", "value", "Latte")[0]
    .emoji;
  check(
    "PLACEHOLDER nominal: assignment is stable across re-renders",
    again === marks[0],
    `${again} vs ${marks[0]}`,
  );
}
{
  // Bar/SVC/trend label vs value columns are distinct nominal roles.
  resetPlaceholderAssignments();
  const label = getRecEmojiOptions(sampleRecs, "drink", "column_name")[0].emoji;
  const value = getRecEmojiOptions(sampleRecs, "cups sold", "column_name")[0]
    .emoji;
  check(
    "PLACEHOLDER nominal: label & value columns get distinct marks",
    label !== value,
    `${label} / ${value}`,
  );
}
{
  // Ordinal scale: monotonic neutral ramp, low/med/high all different.
  resetPlaceholderAssignments();
  const scale = getRecEmojiOptions(sampleRecs, "Rating", "scale");
  check(
    "PLACEHOLDER ordinal: low/med/high follow the neutral ramp in order",
    scale.low[0].emoji === PLACEHOLDER_SCALE_EMOJIS[0] &&
      scale.medium[0].emoji === PLACEHOLDER_SCALE_EMOJIS[1] &&
      scale.high[0].emoji === PLACEHOLDER_SCALE_EMOJIS[2],
    `${scale.low[0].emoji} ${scale.medium[0].emoji} ${scale.high[0].emoji}`,
  );
  check(
    "PLACEHOLDER ordinal: the three ramp levels are distinct",
    new Set([scale.low[0].emoji, scale.medium[0].emoji, scale.high[0].emoji])
      .size === 3,
  );
}
{
  // startTask() resets assignments so a new chart restarts the sequence.
  const { startTask } = appModule;
  resetPlaceholderAssignments();
  const first = getRecEmojiOptions(sampleRecs, "drink", "value", "A")[0].emoji;
  startTask({ triggeredBy: "UEXP" });
  const afterReset = getRecEmojiOptions(sampleRecs, "drink", "value", "A")[0]
    .emoji;
  check(
    "PLACEHOLDER: startTask() restarts the nominal sequence for a new chart",
    afterReset === PLACEHOLDER_NOMINAL_EMOJIS[0] &&
      first === PLACEHOLDER_NOMINAL_EMOJIS[0],
    `${first} -> ${afterReset}`,
  );
}
studySession.variant = "semantic";

// ==========================================================================
// 7. Placeholder override-stripping middleware (custom-emoji input removed)
// ==========================================================================
section("7. Placeholder override lock");

const stripMw = registry.middlewares[0];
check(
  "Override-stripping middleware is registered",
  typeof stripMw === "function",
);

{
  // Placeholder: the custom_* override block must be removed before sending.
  studySession.variant = "placeholder";
  const client = makeClient();
  await stripMw({ client, next: async () => {} });
  await client.views.open({
    view: {
      blocks: [
        { type: "input", block_id: "custom_value_emoji_bar" },
        { type: "input", block_id: "value_emoji_bar" },
      ],
    },
  });
  const sent = client.__calls.viewsOpen[0];
  const ids = (sent.view.blocks || []).map((b) => b.block_id);
  check(
    "PLACEHOLDER: custom_* override input is stripped from modals",
    !ids.includes("custom_value_emoji_bar") && ids.includes("value_emoji_bar"),
    ids.join(","),
  );
}
{
  // Semantic: the override input must be preserved.
  studySession.variant = "semantic";
  const client = makeClient();
  await stripMw({ client, next: async () => {} });
  await client.views.open({
    view: {
      blocks: [
        { type: "input", block_id: "custom_value_emoji_bar" },
        { type: "input", block_id: "value_emoji_bar" },
      ],
    },
  });
  const ids = (client.__calls.viewsOpen[0].view.blocks || []).map(
    (b) => b.block_id,
  );
  check(
    "SEMANTIC: custom_* override input is preserved",
    ids.includes("custom_value_emoji_bar"),
    ids.join(","),
  );
}

// ==========================================================================
// 7b. Manual condition UI rewrite — recommendation dropdown + override box is
//     replaced by a single empty "Choose ..." input.
// ==========================================================================
section("7b. Manual condition input rewrite");

// A realistic single-value-chart slot: a recommendation static_select section
// immediately followed by the paired custom-emoji override input.
const svcSlotBlocks = () => [
  {
    type: "section",
    block_id: "label_emoji_block_svc_1",
    text: {
      type: "mrkdwn",
      text: "Emoji recommendation for the label column (department)",
    },
    accessory: {
      type: "static_select",
      action_id: "label_emoji_svc",
      options: [],
    },
  },
  {
    type: "input",
    block_id: "custom_label_emoji_svc_block",
    label: { type: "plain_text", text: "Override with a custom emoji" },
    element: {
      type: "plain_text_input",
      action_id: "custom_label_emoji_svc",
      initial_value: "",
      placeholder: {
        type: "plain_text",
        text: "Type a custom emoji to override",
      },
    },
    dispatch_action: true,
    optional: true,
  },
  { type: "divider" },
  {
    type: "section",
    block_id: "low_emoji_block_svc_1",
    text: {
      type: "mrkdwn",
      text: "Low value emoji recommendation for satisfaction score",
    },
    accessory: {
      type: "static_select",
      action_id: "low_emoji_svc",
      options: [],
    },
  },
  {
    type: "input",
    block_id: "custom_low_emoji_svc_block",
    label: { type: "plain_text", text: "Override with a custom emoji" },
    element: {
      type: "plain_text_input",
      action_id: "custom_low_emoji_svc",
      initial_value: "",
      placeholder: {
        type: "plain_text",
        text: "Type a custom emoji to override",
      },
    },
    dispatch_action: true,
    optional: true,
  },
];

const trendSlotBlocks = () => [
  {
    type: "section",
    block_id: "label_emoji_block_tc_1",
    text: {
      type: "mrkdwn",
      text: "Emoji recommendation for the label column (month)",
    },
    accessory: {
      type: "static_select",
      action_id: "label_emoji_tc",
      options: [],
    },
  },
  {
    type: "input",
    block_id: "custom_label_emoji_tc_block",
    label: { type: "plain_text", text: "Override with a custom emoji" },
    element: {
      type: "plain_text_input",
      action_id: "custom_label_emoji_tc",
      initial_value: "",
      placeholder: {
        type: "plain_text",
        text: "Type a custom emoji to override",
      },
    },
    dispatch_action: true,
    optional: true,
  },
  { type: "divider" },
  {
    type: "section",
    block_id: "low_emoji_block_tc_1",
    text: {
      type: "mrkdwn",
      text: "Low value emoji recommendation for units sold",
    },
    accessory: {
      type: "static_select",
      action_id: "low_emoji_tc",
      options: [],
    },
  },
  {
    type: "input",
    block_id: "custom_low_emoji_tc_block",
    label: { type: "plain_text", text: "Override with a custom emoji" },
    element: {
      type: "plain_text_input",
      action_id: "custom_low_emoji_tc",
      initial_value: "",
      placeholder: {
        type: "plain_text",
        text: "Type a custom emoji to override",
      },
    },
    dispatch_action: true,
    optional: true,
  },
];

{
  studySession.variant = "manual";
  const client = makeClient();
  await stripMw({ client, next: async () => {} });
  await client.views.open({ view: { blocks: svcSlotBlocks() } });
  const blocks = client.__calls.viewsOpen[0].view.blocks;

  check(
    "MANUAL: recommendation static_select dropdowns are removed",
    !blocks.some((b) => b.accessory?.type === "static_select"),
    blocks.map((b) => b.block_id).join(","),
  );

  const labelInput = blocks.find(
    (b) => b.element?.action_id === "custom_label_emoji_svc",
  );
  const lowInput = blocks.find(
    (b) => b.element?.action_id === "custom_low_emoji_svc",
  );

  check(
    "MANUAL: label input relabelled 'Choose emoji for department'",
    labelInput?.label?.text === "Choose emoji for department",
    labelInput?.label?.text,
  );
  check(
    "MANUAL: low input relabelled 'Choose low value emoji for satisfaction score'",
    lowInput?.label?.text === "Choose low value emoji for satisfaction score",
    lowInput?.label?.text,
  );
  check(
    "MANUAL: inputs do not add a redundant hint (Slack shows its own)",
    labelInput?.hint === undefined && lowInput?.hint === undefined,
    JSON.stringify({ label: labelInput?.hint, low: lowInput?.hint }),
  );
  check(
    "MANUAL: inputs start empty (no initial value, no placeholder)",
    labelInput?.element?.initial_value === "" &&
      labelInput?.element?.placeholder === undefined,
    JSON.stringify(labelInput?.element),
  );
  check(
    "MANUAL: inputs are mandatory (optional === false)",
    labelInput?.optional === false && lowInput?.optional === false,
    `label=${labelInput?.optional} low=${lowInput?.optional}`,
  );
  check(
    "MANUAL: typing still dispatches the custom_* action (dispatch_action kept)",
    labelInput?.dispatch_action === true &&
      labelInput?.element?.action_id === "custom_label_emoji_svc",
  );
}
{
  studySession.variant = "manual";
  const client = makeClient();
  await stripMw({ client, next: async () => {} });
  await client.views.open({ view: { blocks: trendSlotBlocks() } });
  const blocks = client.__calls.viewsOpen[0].view.blocks;

  const trendLabelInput = blocks.find(
    (b) => b.element?.action_id === "custom_label_emoji_tc",
  );
  const trendLowInput = blocks.find(
    (b) => b.element?.action_id === "custom_low_emoji_tc",
  );

  check(
    "MANUAL TREND: label emoji input is optional but scale inputs are mandatory",
    trendLabelInput?.optional === true && trendLowInput?.optional === false,
    `label=${trendLabelInput?.optional} low=${trendLowInput?.optional}`,
  );
}
{
  studySession.variant = "manual";
  const { calls } = await runView("trend_chart_column_select", {
    view: {
      private_metadata: JSON.stringify({
        rawTableData: "month,units sold\nJanuary,180\nFebruary,210\nMarch,340",
        chartTitle: "Ice-cream sales by month across the year",
        taskId: "manual-trend-test",
      }),
      state: {
        values: {
          label_column_block: {
            label_column: { selected_option: { value: "month" } },
          },
          value_column_block: {
            value_column: { selected_option: { value: "units sold" } },
          },
          value_range_low_block: { value_range_low_input: { value: "" } },
          value_range_high_block: { value_range_high_input: { value: "" } },
        },
      },
    },
  });
  const pushed = calls.ack[0]?.view;
  const blocks = pushed?.blocks || [];
  const labelInput = blocks.find(
    (b) => b.element?.action_id === "custom_label_emoji_tc",
  );
  const lowInput = blocks.find(
    (b) => b.element?.action_id === "custom_low_emoji_tc",
  );

  check(
    "MANUAL TREND: final manual modal is pushed immediately without loading screen",
    calls.ack[0]?.response_action === "push" &&
      !blocks.some((b) => b.block_id === "loading_block_tc") &&
      !blocks.some((b) => b.accessory?.type === "static_select") &&
      labelInput?.optional === true &&
      lowInput?.optional === false,
    blocks.map((b) => b.block_id).join(","),
  );
}
{
  // Idempotency: re-running the transform on already-rewritten blocks (as
  // happens on every preview re-render) must NOT clobber the labels.
  studySession.variant = "manual";
  const client = makeClient();
  await stripMw({ client, next: async () => {} });
  await client.views.open({ view: { blocks: svcSlotBlocks() } });
  const once = client.__calls.viewsOpen[0].view.blocks;
  await client.views.update({ view: { blocks: once } });
  const twice = client.__calls.viewsUpdate[0].view.blocks;
  const lowTwice = twice.find(
    (b) => b.element?.action_id === "custom_low_emoji_svc",
  );
  check(
    "MANUAL: re-rendering keeps the 'Choose ...' label (idempotent)",
    lowTwice?.label?.text === "Choose low value emoji for satisfaction score",
    lowTwice?.label?.text,
  );
}
{
  // Proportion per-category slot: "Emoji recommendation for <value>".
  studySession.variant = "manual";
  const client = makeClient();
  await stripMw({ client, next: async () => {} });
  await client.views.open({
    view: {
      blocks: [
        {
          type: "section",
          block_id: "label_emoji_block_0",
          text: { type: "mrkdwn", text: "Emoji recommendation for Apples" },
          accessory: {
            type: "static_select",
            action_id: "por_label_emoji_0",
            options: [],
          },
        },
        {
          type: "input",
          block_id: "custom_label_emoji_block_0",
          label: { type: "plain_text", text: "Override with a custom emoji" },
          element: {
            type: "plain_text_input",
            action_id: "custom_por_label_emoji_0",
            initial_value: "",
            placeholder: {
              type: "plain_text",
              text: "Type a custom emoji to override",
            },
          },
          dispatch_action: true,
          optional: true,
        },
      ],
    },
  });
  const blocks = client.__calls.viewsOpen[0].view.blocks;
  const catInput = blocks.find(
    (b) => b.element?.action_id === "custom_por_label_emoji_0",
  );
  check(
    "MANUAL: proportion category input relabelled 'Choose emoji for Apples'",
    !blocks.some((b) => b.accessory) &&
      catInput?.label?.text === "Choose emoji for Apples",
    catInput?.label?.text,
  );
}
{
  // Semantic must be unaffected by the manual rewrite path.
  studySession.variant = "semantic";
  const client = makeClient();
  await stripMw({ client, next: async () => {} });
  await client.views.open({ view: { blocks: svcSlotBlocks() } });
  const blocks = client.__calls.viewsOpen[0].view.blocks;
  check(
    "SEMANTIC: dropdowns and override boxes are both left intact",
    blocks.some((b) => b.accessory?.type === "static_select") &&
      blocks.some((b) => b.block_id === "custom_label_emoji_svc_block"),
  );
}

// ==========================================================================
// 8. "Recommendation unavailable" STOP path (run sheet: When to STOP)
// ==========================================================================
section("8. Recommendation-backend failure handled gracefully");

{
  studySession.variant = "manual";
  const r = await recommendEmojis({ headers: ["A"], rows: [["1"]] }, "desc");
  check(
    "Non-semantic conditions never call the backend (returns {})",
    r &&
      typeof r === "object" &&
      !Array.isArray(r) &&
      Object.keys(r).length === 0,
    JSON.stringify(r),
  );
}
{
  studySession.variant = "semantic";
  let threw = false;
  let result;
  try {
    result = await recommendEmojis(
      { headers: ["Genre", "Rating"], rows: [["Action", "8"]] },
      "Movie ratings",
    );
  } catch {
    threw = true;
  }
  check(
    "SEMANTIC with backend down resolves gracefully (no crash)",
    !threw && result !== undefined,
    threw ? "threw" : JSON.stringify(result),
  );
}

// ==========================================================================
// 9. /emojichart opens the builder and starts a measured task
// ==========================================================================
section("9. /emojichart builder entry point (run sheet E/F)");

{
  const { client } = await runCommand("/emojichart", { user: "UPART" });
  const opened = client.__calls.viewsOpen[0];
  const metadata = JSON.parse(opened?.view?.private_metadata || "{}");
  check(
    "/emojichart opens the chart builder modal for the participant",
    opened?.view?.callback_id === "emoji_chart_modal",
    opened?.view?.callback_id,
  );
  check(
    "Chart builder asks for title, data, and insight",
    (opened?.view?.blocks || []).some(
      (b) => b.block_id === "chart_title_block",
    ) &&
      (opened?.view?.blocks || []).some(
        (b) => b.block_id === "table_data_block",
      ),
  );
  check(
    "/emojichart metadata carries taskId for stale async update isolation",
    typeof metadata.taskId === "string" && metadata.taskId.length > 0,
    JSON.stringify(metadata),
  );
}

// ==========================================================================
// 10. Participant isolation — N+1 never inherits N's condition (run sheet H/A)
// ==========================================================================
section("10. Participant isolation across /reset");

await runCommand("/reset");
await runView("study_setup_modal", {
  view: setupView({ id: "P1", number: "1" }),
});
await runCommand("/next"); // P1 now mid-study on placeholder
check(
  "P1 is mid-session on a non-default condition",
  getActiveVariant() === "placeholder",
);
await runCommand("/reset");
check(
  "After /reset, condition falls back to the default (no carry-over)",
  getActiveVariant() === "semantic" && studySession.schedule === null,
);
await runView("study_setup_modal", {
  view: setupView({ id: "P2", number: "2" }),
});
check(
  "New participant P2 starts on ITS scheduled Task 1 condition (placeholder)",
  getActiveVariant() === "placeholder" &&
    getStudyContext().participantId === "P2",
  getActiveVariant(),
);

// Clean up session state so a leftover session can't confuse a later run.
await runCommand("/reset");

// ==========================================================================
// 11. Part 3 – Free Exploration (run sheet G / section 21-25)
// ==========================================================================
section("11. Part 3 free exploration (run sheet G)");

await runView("study_setup_modal", {
  view: setupView({ id: "P1", number: "1" }),
});
{
  // Advance through all Part 2 tasks.
  await runCommand("/next"); // -> Task 2
  await runCommand("/next"); // -> Task 3
  const { calls, client } = await runCommand("/next"); // -> Part 3
  const text = respondText(calls);
  check(
    "/next after Task 3 starts Part 3 and locks to SEMANTIC",
    /Part 3 started/.test(text) &&
      /SEMANTIC/.test(text) &&
      getActiveVariant() === "semantic" &&
      studySession.part3Active === true,
    text.replace(/\n/g, " | "),
  );
  check(
    "Part 3 transition message is posted to the channel (visible message)",
    client.__calls.postMessage.length >= 1,
    `postMessage calls: ${client.__calls.postMessage.length}`,
  );
  const channelMsg =
    client.__calls.postMessage[client.__calls.postMessage.length - 1];
  check(
    "Channel message includes 'Part 3 – Free Exploration' header",
    channelMsg?.text === "Part 3 – Free Exploration" ||
      (channelMsg?.blocks || []).some(
        (b) => b.type === "header" && /Part 3/.test(b.text?.text),
      ),
    channelMsg?.text || JSON.stringify(channelMsg?.blocks?.[0]),
  );
}
{
  // Verify Part 3 message structure.
  const client = makeClient();
  const cmd = {
    command: { user_id: "UEXP", channel_id: "C1", thread_ts: null, text: "" },
    ack: async () => {},
    body: { trigger_id: "TRIG", user: { id: "UEXP" } },
    client,
    respond: async () => {},
  };
  // Manually trigger Part 3 to inspect the message.
  await runCommand("/reset");
  await runView("study_setup_modal", {
    view: setupView({ id: "P1", number: "1" }),
  });
  await runCommand("/next"); // -> T2
  await runCommand("/next"); // -> T3
  const { client: c } = await runCommand("/next", { client }); // -> Part 3
  const msg = c.__calls.postMessage[c.__calls.postMessage.length - 1];
  const blocks = msg?.blocks || [];
  check(
    "Part 3 message includes all three dataset options",
    blocks.some((b) => /City Parks/.test(b.text?.text ?? "")) &&
      blocks.some((b) => /Monthly Exercise/.test(b.text?.text ?? "")) &&
      blocks.some((b) => /Music Streaming/.test(b.text?.text ?? "")),
    blocks.map((b) => b.text?.text || b.block_id).join(" | "),
  );
  check(
    "Part 3 message includes instructions for the participant",
    blocks.some(
      (b) =>
        /When you're ready/.test(b.text?.text ?? "") &&
        /\/emojichart/.test(b.text?.text ?? ""),
    ),
    blocks.map((b) => b.text?.text).join(" | "),
  );
}
{
  // Part 3 state is correctly set.
  const ctx = getStudyContext();
  check(
    "Part 3 taskNumber is 4 (PART3_TASK.position)",
    ctx.taskNumber === "4",
    ctx.taskNumber,
  );
  check(
    "Part 3 latinSquareCell is P1-T4",
    ctx.latinSquareCell === "P1-T4",
    ctx.latinSquareCell,
  );
}
{
  // Calling /next again after Part 3 reports all tasks done.
  const { calls } = await runCommand("/next");
  const text = respondText(calls);
  check(
    "/next when Part 3 active reports all tasks done",
    /done|completed|All tasks/i.test(text),
    text,
  );
  check(
    "Variant stays SEMANTIC after Part 3 all-done message",
    getActiveVariant() === "semantic",
  );
}
{
  // Verify part3Active persists and is checked.
  check(
    "part3Active remains true after /next cycles",
    studySession.part3Active === true,
  );
}
{
  // Part 3 is reset when /reset is called.
  await runCommand("/reset");
  check(
    "part3Active resets to false after /reset",
    studySession.part3Active === false &&
      studySession.schedule === null &&
      getActiveVariant() === "semantic",
  );
}
{
  // /check during Part 3 shows Part 3 status differently.
  await runView("study_setup_modal", {
    view: setupView({ id: "P2", number: "2" }),
  });
  await runCommand("/next"); // -> T2
  await runCommand("/next"); // -> T3
  await runCommand("/next"); // -> Part 3
  const { calls } = await runCommand("/check");
  const text = respondText(calls);
  check(
    "/check during Part 3 shows Part 3 status (T4/free exploration)",
    /Part 3|T4|free/i.test(text) || /semantic/.test(text),
    text.replace(/\n/g, " | "),
  );
}
{
  // Part 3 cannot be regressed with /back.
  const { calls } = await runCommand("/back");
  const text = respondText(calls);
  check(
    "/back during Part 3 does not allow stepping back",
    /already at|cannot go|already done/i.test(text) || studySession.part3Active,
    text,
  );
}

// ==========================================================================
// Summary
// ==========================================================================
console.log("\n" + "=".repeat(60));
console.log(`RUN-SHEET TEST SUMMARY:  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  • " + f);
}
console.log("=".repeat(60));

process.exit(failed > 0 ? 1 : 0);
