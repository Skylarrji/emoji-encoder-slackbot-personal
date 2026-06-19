import pkg from "@slack/bolt";
const { App } = pkg;
import stringWidth from "string-width";
import moment from "moment";
import "dotenv/config";
import emojiRegex from "emoji-regex";
import axios from "axios";
import express from "express";
import { fileURLToPath } from "url";
import { logEvent } from "./studyLog.js";
import { getParticipantSchedule, describeSchedule } from "./studySchedule.js";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const runDetached = (label, task) => {
  Promise.resolve()
    .then(task)
    .catch((error) => {
      console.warn(
        `${label}:`,
        error?.data?.error || error?.message || error,
      );
    });
};

app.error(async (error) => {
  console.error(
    "Unhandled Bolt listener error:",
    error?.data?.error || error?.message || error,
  );
});

// ---- Condition-specific modal UI enforcement ------------------------------
// In the "placeholder" condition the participant must NOT be able to override
// the fixed generic symbol, so the custom-emoji override text inputs are
// removed from every modal at send time. Override blocks are the only blocks
// whose block_id starts with "custom_" (see makeCustomEmojiInput), so they can
// be stripped centrally here instead of at the dozens of modal-building call
// sites. The in-memory block arrays are left untouched, so modal bookkeeping
// (e.g. resetCustomEmojiBlock) keeps working in the other conditions.
const isOverrideBlock = (b) =>
  b && typeof b.block_id === "string" && b.block_id.startsWith("custom_");

// ---- Manual-condition UI rewrite ------------------------------------------
// In the "manual" condition the participant types every emoji themselves, so a
// recommendation dropdown (which only ever holds the neutral "unset" marker)
// plus a separate "Override with a custom emoji" box is redundant and
// confusing. For each emoji slot we therefore DROP the recommendation
// static_select and turn the paired custom-emoji input into the single primary
// field, relabelled "Choose <slot> emoji for <column>" with an empty value.
// Like the placeholder strip above, this is done centrally at send time so it
// covers every modal-building call site.

// Matches the action_id of every emoji-recommendation dropdown across the four
// chart types (bar/svc/tc) and the proportion per-category selects.
const EMOJI_SLOT_ACTION_RE =
  /^(?:label|value|low|medium|high)_emoji_(?:bar|svc|tc)$|^por_label_emoji_(?:\d+|other)$/;

const isEmojiDropdownSection = (b) =>
  b &&
  b.type === "section" &&
  b.accessory?.type === "static_select" &&
  typeof b.accessory.action_id === "string" &&
  EMOJI_SLOT_ACTION_RE.test(b.accessory.action_id);

// Turn a recommendation section's descriptive text into a "Choose ..." label.
// Already-transformed labels (starting with "Choose") are returned unchanged so
// the rewrite is idempotent across modal re-renders.
const manualChooseLabel = (text) => {
  if (typeof text !== "string") return "Choose an emoji";
  const t = text.replace(/^\*+|\*+$/g, "").trim();
  if (/^Choose /i.test(t)) return t;
  let m;
  if (
    (m = t.match(
      /^Emoji recommendation for the (?:label|value) column \((.+)\)$/i,
    ))
  )
    return `Choose emoji for ${m[1]}`;
  if ((m = t.match(/^(Low|Medium|High) value emoji recommendation for (.+)$/i)))
    return `Choose ${m[1].toLowerCase()} value emoji for ${m[2]}`;
  if ((m = t.match(/^Emoji recommendation for (.+)$/i)))
    return `Choose emoji for ${m[1]}`;
  return "Choose an emoji";
};

const isOptionalManualEmojiInput = (actionId) => actionId === "custom_label_emoji_tc";

// Rewrite a block array for the manual condition (see comment above).
const manualizeBlocks = (blocks) => {
  const out = [];
  let pendingLabel = null;
  for (const b of blocks) {
    if (isEmojiDropdownSection(b)) {
      pendingLabel = manualChooseLabel(b.text?.text);
      continue; // drop the recommendation dropdown
    }
    if (isOverrideBlock(b) && b.element?.type === "plain_text_input") {
      const { placeholder, ...element } = b.element;
      out.push({
        ...b,
        label: {
          type: "plain_text",
          text: pendingLabel || manualChooseLabel(b.label?.text),
        },
        // Trend labels are optional because the trend chart can be read from the
        // time axis alone; all other manual emoji choices remain required.
        optional: isOptionalManualEmojiInput(element.action_id),
        element: { ...element, initial_value: "" },
      });
      pendingLabel = null;
      continue;
    }
    out.push(b);
  }
  return out;
};

// Apply the active condition's block transform: strip override inputs for
// "placeholder", rewrite slots for "manual", and leave "semantic" untouched.
const transformBlocksForVariant = (blocks) => {
  const variant = getActiveVariant();
  if (variant === "placeholder")
    return blocks.filter((b) => !isOverrideBlock(b));
  if (variant === "manual") return manualizeBlocks(blocks);
  return blocks;
};

const applyVariantBlockTransform = (args) => {
  const variant = getActiveVariant();
  if (
    (variant !== "placeholder" && variant !== "manual") ||
    !args ||
    typeof args !== "object"
  )
    return args;
  if (Array.isArray(args.view?.blocks)) {
    return {
      ...args,
      view: {
        ...args.view,
        blocks: transformBlocksForVariant(args.view.blocks),
      },
    };
  }
  if (Array.isArray(args.blocks)) {
    return { ...args, blocks: transformBlocksForVariant(args.blocks) };
  }
  return args;
};

// Wrap the per-request WebClient's view methods so the condition-specific block
// transform is applied to every views.open/update/push, regardless of which
// handler builds the modal. The same client instance flows from middleware into
// the listener, so patching it here covers all call sites.
app.use(async ({ client, next }) => {
  if (client?.views && !client.views.__variantPatched) {
    for (const method of ["open", "update", "push"]) {
      const original = client.views[method].bind(client.views);
      client.views[method] = (args) =>
        original(applyVariantBlockTransform(args));
    }
    client.views.__variantPatched = true;
  }
  await next();
});

// ---- Study interface variant ----------------------------------------------
// Selects which of the three study conditions the bot runs as:
//   "semantic"    – full semantic emoji recommendations (default; calls backend)
//   "manual"      – no suggestions; participant enters every emoji themselves
//   "placeholder" – non-semantic generic symbol pre-populated in every slot
// Set via the STUDY_VARIANT environment variable. The custom-emoji override
// input is shown in the semantic and manual conditions but removed in the
// placeholder condition (where the fixed symbol is non-overridable); the bot
// identity and overall UI structure are otherwise identical across conditions.
const VALID_VARIANTS = ["semantic", "manual", "placeholder"];
let STUDY_VARIANT = (process.env.STUDY_VARIANT || "semantic").toLowerCase();
if (!VALID_VARIANTS.includes(STUDY_VARIANT)) {
  console.warn(
    `[study] Invalid STUDY_VARIANT="${process.env.STUDY_VARIANT}". ` +
      `Falling back to "semantic". Valid values: ${VALID_VARIANTS.join(", ")}.`,
  );
  STUDY_VARIANT = "semantic";
}

// Generic symbol shown for the non-semantic placeholder condition.
const PLACEHOLDER_EMOJI = process.env.PLACEHOLDER_EMOJI || "⬛";
// Neutral "unset" marker shown for the manual condition before the participant
// enters their own emoji via the custom-emoji input.
const MANUAL_UNSET_EMOJI = process.env.MANUAL_UNSET_EMOJI || "⬜";

// ---- Placeholder-condition mark sets --------------------------------------
// The placeholder condition removes SEMANTICS while holding the encoding's
// STRUCTURE constant, so any semantic > placeholder effect can be attributed to
// meaning rather than merely to having distinguishable marks. To do that the
// placeholder marks mirror the structure of the slot they fill:
//
//   NOMINAL slots (proportion categories; bar/SVC/trend label & value columns)
//     get DISTINCT, equal-weight, hue-coded marks. Hue is categorical (no
//     inherent order) and the defaults avoid red/green so no valence/traffic-
//     light reading is implied, and none resemble the data's topic.
//
//   ORDINAL slots (the low/medium/high value scale) get a monotonic, neutral
//     shade ramp that preserves order without carrying topical meaning.
//
// Both sets are env-overridable (comma/space separated) so the design can be
// tuned or pre-registered without code changes.
const parseEmojiList = (raw) =>
  (raw || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const PLACEHOLDER_NOMINAL_EMOJIS = (() => {
  const list = parseEmojiList(process.env.PLACEHOLDER_NOMINAL_EMOJIS);
  return list.length ? list : ["🔵", "🟠", "🟡", "🟣", "🟤", "⚫"];
})();

const PLACEHOLDER_SCALE_EMOJIS = (() => {
  const list = parseEmojiList(process.env.PLACEHOLDER_SCALE_EMOJIS);
  return list.length >= 3 ? list : ["▪️", "◾", "⬛"];
})();

// Stable, first-seen assignment of DISTINCT nominal placeholders within a single
// chart build. Keyed by a composite slot key drawn from one shared sequence so
// that every nominal slot shown together (e.g. all proportion categories, or a
// bar chart's label vs. value columns) gets its own distinct mark. Cleared at
// the start of each new chart (startTask) and on /reset so assignments never
// leak across charts or participants.
const placeholderNominalAssignments = new Map();

function resetPlaceholderAssignments() {
  placeholderNominalAssignments.clear();
}

function nominalPlaceholderFor(key) {
  const k = String(key ?? "");
  if (!placeholderNominalAssignments.has(k)) {
    const idx = placeholderNominalAssignments.size;
    const set = PLACEHOLDER_NOMINAL_EMOJIS.length
      ? PLACEHOLDER_NOMINAL_EMOJIS
      : [PLACEHOLDER_EMOJI];
    placeholderNominalAssignments.set(k, set[idx % set.length]);
  }
  return placeholderNominalAssignments.get(k);
}

// ---- Experimenter-controlled study session context ------------------------
// Holds the active participant and condition so every task/chart can be
// attributed to the correct Latin-square cell, and so the experimenter can
// switch conditions between tasks WITHOUT restarting the bot. Set via the
// experimenter-only /setup command. STUDY_VARIANT (the env var) acts only
// as the default until a session is configured.
//
// Set EXPERIMENTER_USER_IDS to a comma- or space-separated list of the
// experimenters' Slack user IDs to lock the study-control commands to those
// accounts. (The singular EXPERIMENTER_USER_ID is still accepted for backward
// compatibility.) If neither is set, the commands are open (dev mode) and a
// warning is shown.
const EXPERIMENTER_USER_IDS = (
  process.env.EXPERIMENTER_USER_IDS ||
  process.env.EXPERIMENTER_USER_ID ||
  ""
)
  .split(/[\s,]+/)
  .map((id) => id.trim())
  .filter(Boolean);

const studySession = {
  participantId: null,
  participantNumber: null, // 1-based; selects the Latin-square row
  schedule: null, // ordered array of the participant's 3 creation tasks
  taskIndex: null, // 0-based index into schedule for the current creation task
  variant: null, // overrides STUDY_VARIANT when a session is configured
  chartDataType: null,
  datasetTopic: null,
  taskNumber: null,
  latinSquareCell: null,
  updatedAt: null,
};

// Apply the scheduled creation task at the given index: this is what makes the
// bot AUTO-ADVANCE through the Latin square so the URA never picks a condition.
// Returns false if there is no schedule or the index is out of range.
function applyScheduledTask(index) {
  if (
    !studySession.schedule ||
    index < 0 ||
    index >= studySession.schedule.length
  ) {
    return false;
  }
  const task = studySession.schedule[index];
  studySession.taskIndex = index;
  studySession.variant = task.condition;
  studySession.chartDataType = task.chartType;
  studySession.datasetTopic = task.datasetTopic;
  studySession.taskNumber = String(task.position);
  studySession.latinSquareCell = `P${studySession.participantNumber}-T${task.position}`;
  studySession.updatedAt = new Date().toISOString();
  return true;
}

// Clear all per-participant session state (used by /reset between
// participants so participant N+1 cannot inherit participant N's condition).
function resetStudySession() {
  studySession.participantId = null;
  studySession.participantNumber = null;
  studySession.schedule = null;
  studySession.taskIndex = null;
  studySession.variant = null;
  studySession.chartDataType = null;
  studySession.datasetTopic = null;
  studySession.taskNumber = null;
  studySession.latinSquareCell = null;
  studySession.updatedAt = null;
  resetPlaceholderAssignments();
}

// The condition currently in effect: the configured session variant if set,
// otherwise the STUDY_VARIANT env default.
function getActiveVariant() {
  return studySession.variant || STUDY_VARIANT;
}

// A plain snapshot of the active context, for logging/attribution (item 3).
function getStudyContext() {
  return {
    participantId: studySession.participantId,
    participantNumber: studySession.participantNumber,
    variant: getActiveVariant(),
    chartDataType: studySession.chartDataType,
    datasetTopic: studySession.datasetTopic,
    taskNumber: studySession.taskNumber,
    taskIndex: studySession.taskIndex,
    taskCount: studySession.schedule ? studySession.schedule.length : null,
    latinSquareCell: studySession.latinSquareCell,
  };
}

// True if the given Slack user is allowed to run study-control commands.
function isExperimenter(userId) {
  return (
    EXPERIMENTER_USER_IDS.length === 0 || EXPERIMENTER_USER_IDS.includes(userId)
  );
}

// ---- Per-task measurement accumulator (item 3: logging) -------------------
// Tracks the currently in-progress chart-creation task so we can measure
// completion time and compare the emojis SHOWN to the participant against the
// emojis they ultimately CHOSE (acceptance vs. override).
let currentTask = null;

function startTask(meta = {}) {
  // Each new chart build gets a fresh set of distinct placeholder marks.
  resetPlaceholderAssignments();
  currentTask = {
    taskId: `${studySession.participantId ?? "anon"}_${Date.now()}`,
    startTs: Date.now(),
    context: getStudyContext(),
    shown: {}, // slotKey -> [emoji, ...] (the options first shown for that slot)
    ...meta,
  };
  return currentTask;
}

function isCurrentTaskMetadata(privateMetadata = {}) {
  return !privateMetadata.taskId || currentTask?.taskId === privateMetadata.taskId;
}

function logSkippedStaleModalUpdate(chartType, taskId) {
  console.warn(
    `Skipping ${chartType} recommendation modal update: stale task`,
    taskId || "unknown",
  );
}

// Record the option list shown for one slot. Keeps the first-seen set so later
// re-renders of the same slot don't overwrite what was originally presented.
function recordShown(slotKey, options) {
  if (!currentTask || currentTask.shown[slotKey]) return;
  currentTask.shown[slotKey] = (options || [])
    .map((o) => o?.emoji)
    .filter(Boolean);
}

// Record whatever getRecEmojiOptions returned for a slot (array or scale obj).
function recordShownResult(type, colName, value, result) {
  if (!currentTask) return;
  const base = value != null ? `${colName}:${value}` : `${colName}`;
  if (result && !Array.isArray(result) && result.low) {
    recordShown(`scale_low:${base}`, result.low);
    recordShown(`scale_medium:${base}`, result.medium);
    recordShown(`scale_high:${base}`, result.high);
  } else {
    recordShown(`${type}:${base}`, result);
  }
}

// Map the final preview view back to a chart type for attribution.
function chartTypeFromView(view, pm) {
  const ext = view?.external_id || "";
  if (ext.includes("_bar")) return "bar";
  if (ext.includes("_svc")) return "single_value";
  if (ext.includes("_trend")) return "trend";
  if (pm && pm.emojiMap) return "proportion";
  return "unknown";
}

// Pull the participant's final emoji choices out of the post-stage metadata.
function collectChosen(pm) {
  const out = [];
  const add = (slot, emoji) => {
    if (emoji && emoji !== "none") out.push({ slot, emoji });
  };
  add("label", pm.labelEmoji);
  add("value", pm.valueEmoji);
  add("low", pm.lowEmoji);
  add("medium", pm.mediumEmoji);
  add("high", pm.highEmoji);
  if (pm.emojiMap && typeof pm.emojiMap === "object") {
    for (const [k, v] of Object.entries(pm.emojiMap)) add(`map:${k}`, v);
  }
  return out;
}

// Finalize the in-progress task: compute timing + acceptance/override metrics
// and append a task_submit event. Safe to call even if no task is active.
async function finalizeTask({ view, private_metadata, postedBy }) {
  const task = currentTask;
  currentTask = null;

  const pm = private_metadata || {};
  const chosen = collectChosen(pm);
  const shown = task?.shown || {};
  const shownLists = Object.values(shown);
  const shownTops = new Set(shownLists.map((l) => l[0]).filter(Boolean));
  const shownAll = new Set(shownLists.flat());

  // Acceptance taxonomy per chosen slot:
  //   accepted – used the top option shown for some slot
  //   modified – chose a different option that WAS shown (non-top)
  //   custom   – entered an emoji that was never shown (typed override)
  let accepted = 0;
  let modified = 0;
  let custom = 0;
  for (const { emoji } of chosen) {
    if (shownTops.has(emoji)) accepted++;
    else if (shownAll.has(emoji)) modified++;
    else custom++;
  }
  const overrideCount = modified + custom;

  await logEvent("task_submit", {
    taskId: task?.taskId ?? null,
    context: task?.context ?? getStudyContext(),
    chartType: chartTypeFromView(view, pm),
    chartTitle: pm.chartTitle ?? null,
    durationMs: task ? Date.now() - task.startTs : null,
    shown,
    chosen,
    metrics: {
      chosenCount: chosen.length,
      accepted,
      modified,
      custom,
      overrideCount,
    },
    postedBy: postedBy ?? null,
  });
}

// ---- Experimenter study-control commands ----------------------------------
// /setup  – modal to load a participant; the bot then AUTO-ADVANCES the
//           condition for each task from the Latin square (studySchedule.js).
// /next   – advance to the next scheduled creation task's condition.
// /back   – step back to the previous scheduled task (error recovery).
// /check  – show the current session context (ephemeral).
// /reset  – clear all session state between participants.
app.command("/setup", async ({ command, ack, body, client, respond }) => {
  await ack();

  if (!isExperimenter(command.user_id)) {
    await respond({
      response_type: "ephemeral",
      text: ":no_entry: This command is restricted to the experimenter.",
    });
    return;
  }

  // Condition is normally chosen automatically from the Latin square. The
  // explicit options are kept only for piloting / one-off manual control.
  const conditionOptions = [
    {
      text: { type: "plain_text", text: "Auto (from Latin-square schedule)" },
      value: "auto",
    },
    {
      text: { type: "plain_text", text: "Manual override: Semantic" },
      value: "semantic",
    },
    {
      text: { type: "plain_text", text: "Manual override: Manual" },
      value: "manual",
    },
    {
      text: { type: "plain_text", text: "Manual override: Placeholder" },
      value: "placeholder",
    },
  ];

  const textInput = (blockId, actionId, label, initial, optional = true) => ({
    type: "input",
    block_id: blockId,
    optional,
    label: { type: "plain_text", text: label },
    element: {
      type: "plain_text_input",
      action_id: actionId,
      ...(initial ? { initial_value: String(initial) } : {}),
    },
  });

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "study_setup_modal",
        title: { type: "plain_text", text: "Study Setup" },
        submit: { type: "plain_text", text: "Start participant" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "Enter the participant ID and their assigned *number* from the Schedule sheet. The bot will load that participant's condition order automatically and start at Task 1.",
              },
            ],
          },
          textInput(
            "participant_id_block",
            "participant_id_input",
            "Participant ID (e.g. P4)",
            studySession.participantId,
            false,
          ),
          textInput(
            "participant_number_block",
            "participant_number_input",
            "Participant number (1, 2, 3, etc,) - selects the Latin-square row",
            studySession.participantNumber,
            false,
          ),
          {
            type: "input",
            block_id: "condition_block",
            label: { type: "plain_text", text: "Condition mode" },
            element: {
              type: "static_select",
              action_id: "condition_input",
              options: conditionOptions,
              initial_option: conditionOptions[0],
            },
          },
        ],
      },
    });
  } catch (error) {
    console.error("Error opening study setup modal:", error);
  }
});

app.view("study_setup_modal", async ({ ack, view, body, client }) => {
  const v = view.state.values;
  const trim = (s) => {
    const t = (s || "").trim();
    return t.length ? t : null;
  };

  const participantId = trim(v.participant_id_block.participant_id_input.value);
  const numberRaw = trim(
    v.participant_number_block.participant_number_input.value,
  );
  const mode = v.condition_block.condition_input.selected_option.value;

  // Validate the participant number BEFORE acking so we can surface a clear,
  // inline error instead of silently misassigning a condition.
  const n = Number(numberRaw);
  if (!Number.isInteger(n) || n < 1) {
    await ack({
      response_action: "errors",
      errors: {
        participant_number_block:
          "Enter a positive whole number (1, 2, 3, ...).",
      },
    });
    return;
  }
  await ack();

  // Load the participant's schedule and start at Task 1.
  resetStudySession();
  studySession.participantId = participantId;
  studySession.participantNumber = n;
  studySession.schedule = getParticipantSchedule(n);
  applyScheduledTask(0);

  // A manual override forces a single condition regardless of the schedule
  // (piloting only). The schedule is still loaded so /next keeps working.
  if (mode !== "auto") {
    studySession.variant = mode;
  }

  logEvent("session_setup", {
    context: getStudyContext(),
    mode,
    scheduleSummary: describeSchedule(n),
  });
  console.log(
    `[study] Participant ${participantId} (#${n}) loaded - schedule: ${describeSchedule(n)}` +
      (mode !== "auto" ? ` [manual override: ${mode}]` : ""),
  );

  try {
    const ctx = getStudyContext();
    const warn =
      EXPERIMENTER_USER_IDS.length > 0
        ? ""
        : "\n:warning: No experimenter user IDs are set (EXPERIMENTER_USER_IDS); study-control commands are open to all users.";
    // Open (or reuse) the DM channel first so the confirmation does not depend
    // on a pre-existing IM with the bot (avoids a `not_found` on first use).
    const im = await client.conversations.open({ users: body.user.id });
    await client.chat.postMessage({
      channel: im.channel.id,
      text:
        `:white_check_mark: *Participant loaded*\n` +
        `• Participant: \`${ctx.participantId ?? "-"}\` (number \`${n}\`)\n` +
        `• Full schedule: \`${describeSchedule(n)}\`\n` +
        `• Now on: *Task ${ctx.taskNumber} of ${ctx.taskCount}* - condition \`${ctx.variant}\`` +
        (mode !== "auto" ? `  _(manual override)_` : "") +
        `\n• Run \`/next\` before each new creation task.` +
        warn,
    });
  } catch (error) {
    console.error("Error confirming study setup:", error);
  }
});

// Shared helper: a prominent, plain-language status line the URA verifies
// against the Schedule sheet before every task.
function studyStatusText() {
  const ctx = getStudyContext();
  const configured = studySession.schedule !== null;
  if (!configured) {
    return (
      `*No participant loaded.*\n` +
      `• Active condition (default): \`${ctx.variant}\`\n` +
      `• Run \`/setup\` to load a participant.`
    );
  }
  return (
    `*Participant ${ctx.participantId ?? "-"}* (number ${ctx.participantNumber})\n` +
    `• ➤ *Task ${ctx.taskNumber} of ${ctx.taskCount}*  ·  chart \`${ctx.chartDataType}\`  ·  condition *${String(ctx.variant).toUpperCase()}*\n` +
    `• Full schedule: \`${describeSchedule(ctx.participantNumber)}\`\n` +
    `• Updated: \`${studySession.updatedAt ?? "-"}\``
  );
}

app.command("/check", async ({ command, ack, respond }) => {
  await ack();

  if (!isExperimenter(command.user_id)) {
    await respond({
      response_type: "ephemeral",
      text: ":no_entry: This command is restricted to the experimenter.",
    });
    return;
  }

  await respond({ response_type: "ephemeral", text: studyStatusText() });
});

// Advance to the next scheduled creation task (auto-sets that task's condition).
app.command("/next", async ({ command, ack, respond }) => {
  await ack();

  if (!isExperimenter(command.user_id)) {
    await respond({
      response_type: "ephemeral",
      text: ":no_entry: This command is restricted to the experimenter.",
    });
    return;
  }

  if (!studySession.schedule) {
    await respond({
      response_type: "ephemeral",
      text: ":warning: No participant loaded. Run `/setup` first.",
    });
    return;
  }

  const next = (studySession.taskIndex ?? -1) + 1;
  if (next >= studySession.schedule.length) {
    await respond({
      response_type: "ephemeral",
      text:
        `:checkered_flag: All ${studySession.schedule.length} creation tasks are done for ` +
        `\`${studySession.participantId}\`. Run \`/reset\` before the next participant.`,
    });
    return;
  }

  applyScheduledTask(next);
  logEvent("task_advance", { context: getStudyContext() });
  await respond({ response_type: "ephemeral", text: studyStatusText() });
});

// Step back to the previous scheduled task (error recovery if /next was
// run too early).
app.command("/back", async ({ command, ack, respond }) => {
  await ack();

  if (!isExperimenter(command.user_id)) {
    await respond({
      response_type: "ephemeral",
      text: ":no_entry: This command is restricted to the experimenter.",
    });
    return;
  }

  if (!studySession.schedule || studySession.taskIndex === null) {
    await respond({
      response_type: "ephemeral",
      text: ":warning: No participant loaded. Run `/setup` first.",
    });
    return;
  }

  const prev = studySession.taskIndex - 1;
  if (prev < 0) {
    await respond({
      response_type: "ephemeral",
      text: ":warning: Already at Task 1; cannot go back further.",
    });
    return;
  }

  applyScheduledTask(prev);
  logEvent("task_back", { context: getStudyContext() });
  await respond({ response_type: "ephemeral", text: studyStatusText() });
});

// Clear all session state between participants.
app.command("/reset", async ({ command, ack, respond }) => {
  await ack();

  if (!isExperimenter(command.user_id)) {
    await respond({
      response_type: "ephemeral",
      text: ":no_entry: This command is restricted to the experimenter.",
    });
    return;
  }

  const prior = studySession.participantId;
  logEvent("session_reset", { previousParticipant: prior });
  resetStudySession();
  await respond({
    response_type: "ephemeral",
    text:
      `:broom: Session cleared${prior ? ` (was \`${prior}\`)` : ""}. ` +
      `Active condition is back to the \`${STUDY_VARIANT}\` default until the next \`/setup\`.`,
  });
});

app.command("/emojichart", async ({ command, ack, body, client }) => {
  await ack();

  // Begin a measured chart-creation task: capture the start time and the
  // active study context, and reset the per-task shown/chosen accumulator.
  const task = startTask({ triggeredBy: command.user_id });
  logEvent("task_start", {
    taskId: currentTask.taskId,
    context: currentTask.context,
    triggeredBy: command.user_id,
  });

  const metadata = {
    taskId: task.taskId,
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
            type: "input",
            block_id: "insight_block",
            label: {
              type: "plain_text",
              text: "What insight do you want to generate?",
            },
            element: {
              type: "static_select",
              action_id: "insight_input",
              placeholder: { type: "plain_text", text: "Select an insight" },
              options: [
                {
                  text: { type: "plain_text", text: "Comparison" },
                  value: "comparison",
                },
                {
                  text: { type: "plain_text", text: "Trend" },
                  value: "trend",
                },
                {
                  text: { type: "plain_text", text: "Proportion" },
                  value: "proportion",
                },
              ],
            },
            dispatch_action: true,
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
    (b) => b.block_id !== "chart_type_block",
  );
  // If 'comparison' is selected, add chart type block
  if (selected === "comparison") {
    blocks.push({
      type: "input",
      block_id: "chart_type_block",
      label: {
        type: "plain_text",
        text: "What type of chart do you want to visualize?",
      },
      element: {
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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Parse pasted CSV text into a header array and trimmed row arrays.
const parseTableData = (rawTableData) => {
  const lines = (rawTableData || "").trim().split("\n");
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = lines
    .slice(1)
    .map((line) => line.split(",").map((cell) => cell.trim()));
  return { headers, rows };
};

// Sum a numeric column grouped by a label column, skipping non-numeric values.
const aggregateSum = (rows, labelIdx, valueIdx) => {
  const agg = {};
  rows.forEach((row) => {
    const label = row[labelIdx];
    const value = Number(row[valueIdx]);
    if (!isNaN(value)) agg[label] = (agg[label] || 0) + value;
  });
  return agg;
};

// Count occurrences of each (lowercased) label. When freqIdx >= 0, sum that
// numeric column instead of counting rows. Used by the proportion chart.
const aggregateFrequency = (rows, labelIdx, freqIdx) => {
  const agg = {};
  rows.forEach((row) => {
    const key = (row[labelIdx]?.trim() || "unknown").toLowerCase();
    if (freqIdx >= 0) {
      const freqVal = Number(row[freqIdx]?.trim());
      if (!isNaN(freqVal)) agg[key] = (agg[key] || 0) + freqVal;
    } else {
      agg[key] = (agg[key] || 0) + 1;
    }
  });
  return agg;
};

// Build a Slack static_select option whose label and value are the same string.
const toOption = (text) => ({
  text: { type: "plain_text", text },
  value: text,
});

// Map a list of strings to Slack static_select options.
const toOptions = (values) => values.map(toOption);

// Read whether a "show" checkbox is currently selected in the view state.
const readCheckbox = (state, blockId, actionId, defaultValue = false) =>
  state[blockId]?.[actionId]?.selected_options?.some(
    (opt) => opt.value === "show",
  ) ?? defaultValue;

// Build the "Override with a custom emoji" text input block used in every chart.
const makeCustomEmojiInput = (actionId, blockId) => ({
  type: "input",
  block_id: blockId,
  label: { type: "plain_text", text: `Override with a custom emoji` },
  element: {
    type: "plain_text_input",
    action_id: actionId,
    initial_value: "",
    placeholder: {
      type: "plain_text",
      text: "Type a custom emoji to override",
    },
  },
  dispatch_action: true,
  optional: true,
});

// Replace a custom-emoji input block (matched by prefix) with a fresh, empty one
// so its previous override value is cleared. Mutates the given blocks array.
const resetCustomEmojiBlock = (blocks, blockIdPrefix, actionId) => {
  const idx = blocks.findIndex((b) => b.block_id.startsWith(blockIdPrefix));
  if (idx !== -1) {
    blocks[idx] = makeCustomEmojiInput(
      actionId,
      `${blockIdPrefix}_reset_${Date.now()}`,
    );
  }
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
  "may",
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

  // Match month/weekday names BEFORE the loose moment(str) fallback below.
  // Passing a bare name like "february" to moment(str) cannot be parsed with a
  // recognized RFC2822/ISO format, so moment falls back to JS Date() and emits
  // a deprecation warning - even though these named branches handle it cleanly.
  if (monthNames.includes(str)) {
    const monthIndex = monthNames.indexOf(str) % 12;
    return moment().month(monthIndex).startOf("month");
  }

  if (weekdayNames.includes(str)) {
    const dayIndex = weekdayNames.indexOf(str) % 7;
    return moment().day(dayIndex);
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

  return moment.invalid();
};

export const compareTemporalLabels = (a, b) => {
  const aMoment = parseTemporalLabel(a);
  const bMoment = parseTemporalLabel(b);
  return aMoment.valueOf() - bMoment.valueOf();
};

const singleEmojiRegex = new RegExp(`^(?:${emojiRegex().source})$`); // used for custom emoji validation

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

  const private_metadata = JSON.stringify({
    ...oldMetadata,
    rawTableData,
    chartType,
    chartTitle,
  });

  if (chartType === "bar_chart") {
    // Only show the two questions for bar chart
    const catOptions = toOptions(getCategoricalColumns(headers, rows));
    const quantOptions = toOptions(getQuantitativeColumns(headers, rows));
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
              initial_option: catOptions[0],
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
              initial_option: quantOptions[0],
            },
          },
        ],
      },
    });
    return;
  }

  if (chartType === "single_value_chart") {
    const catOptions = toOptions(getCategoricalColumns(headers, rows));
    const quantOptions = toOptions(getQuantitativeColumns(headers, rows));

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
              initial_option: catOptions[0],
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
              initial_option: quantOptions[0],
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
    const quantOptions = toOptions(getQuantitativeColumns(headers, rows));
    const temporalOptions = toOptions(getTemporalColumns(headers, rows));

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
              initial_option: temporalOptions[0],
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
              initial_option: quantOptions[0],
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
    const catOptions = toOptions(getGeneralCategoricalColumns(headers, rows));
    const quantOptions = toOptions(getQuantitativeColumns(headers, rows));

    const noneOption = {
      text: { type: "plain_text", text: "None (Use Emoji Column)" },
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
              initial_option: catOptions[0],
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
              initial_option:
                quantOptions.length > 0 ? quantOptions[0] : noneOption,
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
});

// helper function to call the Python emoji recommendation script
async function callEmojiRecommendation(tableData, tableDescription) {
  try {
    const numColumns = tableData.headers.length;
    const descriptionRow = tableDescription + ",".repeat(numColumns - 1);
    const csvContent = [
      descriptionRow,
      tableData.headers.join(","),
      ...tableData.rows.map((row) => row.join(",")),
    ].join("\n");
    const response = await axios.post(
      process.env.EMOJI_API_URL + "/recommend",
      {
        csv: csvContent,
        top_k: 5,
      },
    );
    return response.data;
  } catch (err) {
    console.error("Emoji API error:", err);
    return {};
  }
}

// cache for emoji recommendations to avoid repeated calls
const emojiRecommendationCache = new Map();
const inFlight = new Map();

async function recommendEmojis(tableData = null, tableDescription = null) {
  if (!tableData || !tableDescription) return [];

  // Non-semantic study variants never call the recommendation backend; the
  // emoji content is supplied entirely by getRecEmojiOptions().
  const variant = getActiveVariant();
  if (variant !== "semantic") return {};

  // Key the cache by variant so a runtime condition switch can never serve a
  // semantic recommendation into a non-semantic condition.
  const cacheKey = `${variant}_${tableDescription}_${JSON.stringify(tableData)}`;

  // return cache immediately if available
  if (emojiRecommendationCache.has(cacheKey)) {
    // console.log("Using cached emoji recommendations.");
    return emojiRecommendationCache.get(cacheKey);
  }

  // if already computing, wait for it
  if (inFlight.has(cacheKey)) {
    // console.log("Awaiting in-flight recommendation call.");
    return inFlight.get(cacheKey);
  }

  // otherwise start computing
  const promise = (async () => {
    try {
      const recommendations = await callEmojiRecommendation(
        tableData,
        tableDescription,
      );
      // console.log("Emoji recommendations:", JSON.stringify(recommendations));
      if (
        recommendations &&
        typeof recommendations === "object" &&
        Object.keys(recommendations).length > 0
      ) {
        emojiRecommendationCache.set(cacheKey, recommendations);
        // console.log("Cached emoji recommendations.");
      }
      return recommendations || [];
    } catch (err) {
      console.error(
        "Failed to get emoji recommendations from Python backend:",
        err,
      );
      return [];
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, promise);
  return promise;
}

function getRecEmojiOptions(recommendations, colName, type, value = null) {
  // Thin wrapper that records, for study logging, the option set actually shown
  // to the participant for this slot, then returns the underlying result.
  const result = _getRecEmojiOptions(recommendations, colName, type, value);
  recordShownResult(type, colName, value, result);
  return result;
}

function _getRecEmojiOptions(recommendations, colName, type, value = null) {
  // Study-variant overrides. Returning a single non-empty option keeps every
  // Slack static_select valid and ensures the call-site fallbacks (e.g.
  // `|| "📉"`) never fire, so no semantic default leaks into these conditions:
  //   manual      – neutral "unset" marker; participant picks via custom input
  //   placeholder – structure-matched non-semantic marks (distinct per nominal
  //                 slot; a monotonic neutral ramp for the low/med/high scale)
  const variant = getActiveVariant();
  if (variant === "manual") {
    const fill = { emoji: MANUAL_UNSET_EMOJI };
    if (type === "scale") {
      return { low: [fill], medium: [fill], high: [fill] };
    }
    return [fill];
  }
  if (variant === "placeholder") {
    if (type === "scale") {
      // Ordinal: monotonic neutral shade ramp (order preserved, no meaning).
      return {
        low: [{ emoji: PLACEHOLDER_SCALE_EMOJIS[0] }],
        medium: [{ emoji: PLACEHOLDER_SCALE_EMOJIS[1] }],
        high: [{ emoji: PLACEHOLDER_SCALE_EMOJIS[2] }],
      };
    }
    // Nominal: a DISTINCT mark per category value (type "value") or per column
    // role (type "column_name"), drawn from one shared per-chart sequence so
    // marks shown together never collide.
    const key =
      value != null ? `${colName}::value::${value}` : `${colName}::col`;
    return [{ emoji: nominalPlaceholderFor(key) }];
  }

  let emojis = [];

  if (type === "value") {
    // The proportion-chart aggregation lowercases label values, but the backend
    // keys categorical_value_emojis by the original-case value (e.g. "Horror").
    // Match case-insensitively so the lookup doesn't silently return [] and
    // produce an empty Slack static_select (which Slack rejects).
    const valueMap = recommendations?.categorical_value_emojis?.[colName] || {};
    const matchKey =
      value in valueMap
        ? value
        : Object.keys(valueMap).find(
            (k) => k.toLowerCase() === String(value).toLowerCase(),
          );
    emojis = (matchKey != null ? valueMap[matchKey] : []) || [];
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
    }),
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

const barChartEmojiActions = [
  "label_emoji_bar",
  "custom_label_emoji_bar",
  "value_emoji_bar",
  "custom_value_emoji_bar",
  "show_legend_bar",
  "show_title_checkbox_bar",
  "show_end_emoji_checkbox_bar",
];

barChartEmojiActions.forEach((actionId) => {
  app.action(actionId, async ({ body, action, ack, client }) => {
    const view = body.view;
    const state = view?.state?.values || {};
    const private_metadata = JSON.parse(view.private_metadata || "{}");
    const rawTableData = private_metadata.rawTableData;
    const labelCol = private_metadata.labelCol;
    const valueCol = private_metadata.valueCol;
    const chartTitle = private_metadata.chartTitle;
    const triggeredId = action.action_id;
    const blockId = action.block_id;

    let labelEmoji = private_metadata.labelEmoji || "none";
    let valueEmoji = private_metadata.valueEmoji || "❓";
    let dropdownValue, customValue;

    // --- validate custom emoji input ---
    if (triggeredId.startsWith("custom_")) {
      const customValueRaw = action.value?.trim() || "";
      const isValid = customValueRaw && singleEmojiRegex.test(customValueRaw);
      if (!isValid) {
        await ack({
          response_action: "errors",
          errors: { [blockId]: "Please enter exactly one emoji character." },
        });
        return;
      }
    }

    await ack();

    const blocks = [...view.blocks];

    // --- handle dropdown vs custom, clearing custom inputs on dropdown ---
    if (triggeredId === "label_emoji_bar") {
      dropdownValue = action.selected_option?.value;
      labelEmoji = dropdownValue;
      resetCustomEmojiBlock(
        blocks,
        "custom_label_emoji_block_bar",
        "custom_label_emoji_bar",
      );
    } else if (triggeredId === "custom_label_emoji_bar") {
      customValue = action.value?.trim();
      if (customValue) labelEmoji = customValue;
    }

    if (triggeredId === "value_emoji_bar") {
      dropdownValue = action.selected_option?.value;
      valueEmoji = dropdownValue;
      resetCustomEmojiBlock(
        blocks,
        "custom_value_emoji_block_bar",
        "custom_value_emoji_bar",
      );
    } else if (triggeredId === "custom_value_emoji_bar") {
      customValue = action.value?.trim();
      if (customValue) valueEmoji = customValue;
    }

    const showLegend = readCheckbox(
      state,
      "show_legend_block_bar",
      "show_legend_bar",
    );
    const showTitle = readCheckbox(
      state,
      "show_title_block_bar",
      "show_title_checkbox_bar",
      true,
    );
    const showEmojiAtEnd = readCheckbox(
      state,
      "show_end_emoji_block_bar",
      "show_end_emoji_checkbox_bar",
    );

    const showLabelEmoji = labelEmoji !== "none";

    // --- parse and aggregate ---
    const { headers, rows } = parseTableData(rawTableData);
    const labelIdx = headers.indexOf(labelCol);
    const valueIdx = headers.indexOf(valueCol);
    const agg = aggregateSum(rows, labelIdx, valueIdx);

    // --- build preview ---
    const preview = generateBarChartPreview({
      agg,
      labelEmoji,
      valueEmoji,
      showLabelEmoji,
      showLegend,
      valueCol,
      legendLabel: valueCol,
      chartTitle,
      showTitle,
      showEmojiAtEnd,
    });

    const previewIdx = blocks.findIndex(
      (b) => b.block_id === "preview_block_bar",
    );
    if (previewIdx !== -1) {
      blocks[previewIdx] = {
        ...blocks[previewIdx],
        text: { type: "mrkdwn", text: "```\n" + preview + "\n```" },
      };
    }

    const new_private_metadata = JSON.stringify({
      ...private_metadata,
      preview,
      labelEmoji,
      valueEmoji,
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

app.view("bar_chart_column_select", async ({ ack, view, body, client }) => {
  const private_metadata = JSON.parse(view.private_metadata || "{}");
  const rawTableData = private_metadata.rawTableData;
  const chartTitle = private_metadata.chartTitle;

  const labelCol =
    view.state.values.label_column_block.label_column.selected_option.value;
  const valueCol =
    view.state.values.value_column_block.value_column.selected_option.value;

  // parse CSV
  const { headers, rows } = parseTableData(rawTableData);
  const labelIdx = headers.indexOf(labelCol);
  const valueIdx = headers.indexOf(valueCol);

  // aggregate values
  const agg = aggregateSum(rows, labelIdx, valueIdx);

  // placeholder preview
  const placeholderPreview = generateBarChartPreview({
    agg,
    labelEmoji: "none",
    valueEmoji: "❓",
    showLabelEmoji: false,
    showLegend: false,
    valueCol,
    chartTitle,
    showTitle: true,
    showEmojiAtEnd: false,
  });

  const new_private_metadata = JSON.stringify({
    ...private_metadata,
    labelCol,
    valueCol,
    preview: placeholderPreview,
  });

  // ---- initial ack with placeholders ----
  await ack({
    response_action: "push",
    view: {
      type: "modal",
      external_id: "emoji_chart_modal_bar",
      callback_id: "post_final_message",
      private_metadata: new_private_metadata,
      title: { type: "plain_text", text: "Bar Chart Builder", emoji: true },
      submit: { type: "plain_text", text: "Finish", emoji: true },
      close: { type: "plain_text", text: "Back", emoji: true },
      blocks: [
        {
          type: "section",
          block_id: "loading_block_bar",
          text: { type: "mrkdwn", text: "⏳ Getting emoji recommendations..." },
        },
        {
          type: "section",
          block_id: "label_emoji_block_bar",
          text: {
            type: "mrkdwn",
            text: `*Label emoji for ${labelCol}*: No label`,
          },
        },
        {
          type: "section",
          block_id: "value_emoji_block_bar",
          text: { type: "mrkdwn", text: `*Value emoji for ${valueCol}*: ❓` },
        },
        {
          type: "section",
          block_id: "show_end_emoji_block_bar",
          text: {
            type: "mrkdwn",
            text: "*Show emoji only at the end of each bar?*\n[ ] Show emoji only at the end",
          },
        },
        {
          type: "section",
          block_id: "show_title_block_bar",
          text: {
            type: "mrkdwn",
            text: "*Show chart title?*\n[x] Show chart title",
          },
        },
        {
          type: "section",
          block_id: "show_legend_block_bar",
          text: { type: "mrkdwn", text: "*Show legend?*\n[ ] Show legend" },
        },
        {
          type: "section",
          block_id: "preview_block_bar",
          text: {
            type: "mrkdwn",
            text: "```\n" + placeholderPreview + "\n```",
          },
        },
      ],
    },
  });

  // ---- async update with real emoji recommendations ----
  runDetached("Bar recommendation modal update failed", async () => {
    if (!isCurrentTaskMetadata(private_metadata)) {
      logSkippedStaleModalUpdate("bar", private_metadata.taskId);
      return;
    }
    const tableData = { headers, rows };
    const tableDescription = chartTitle || "Bar chart";

    const recommendations = await recommendEmojis(tableData, tableDescription);
    if (!isCurrentTaskMetadata(private_metadata)) {
      logSkippedStaleModalUpdate("bar", private_metadata.taskId);
      return;
    }
    const labelRecs = getRecEmojiOptions(
      recommendations,
      labelCol,
      "column_name",
    );
    const valueRecs = getRecEmojiOptions(
      recommendations,
      valueCol,
      "column_name",
    );

    const labelEmoji = "none";
    const valueEmoji = valueRecs[0]?.emoji || "❓";

    const updatedPreview = generateBarChartPreview({
      agg,
      labelEmoji,
      valueEmoji,
      showLabelEmoji: false,
      showLegend: false,
      valueCol,
      chartTitle,
      showTitle: true,
      showEmojiAtEnd: false,
    });

    const updatedBlocks = [
      // Label emoji
      {
        type: "section",
        block_id: `label_emoji_block_bar_${Date.now()}`,
        text: {
          type: "mrkdwn",
          text: `Emoji recommendation for the label column (${labelCol})`,
        },
        accessory: {
          type: "static_select",
          action_id: "label_emoji_bar",
          options: [
            { text: { type: "plain_text", text: "No label" }, value: "none" },
            ...labelRecs.map((e) => ({
              text: { type: "plain_text", text: e.emoji },
              value: e.emoji,
            })),
          ],
          initial_option: {
            text: { type: "plain_text", text: "No label" },
            value: "none",
          },
        },
      },
      makeCustomEmojiInput(
        "custom_label_emoji_bar",
        "custom_label_emoji_block_bar",
      ),
      { type: "divider" },
      // Value emoji
      {
        type: "section",
        block_id: `value_emoji_block_bar_${Date.now()}`,
        text: {
          type: "mrkdwn",
          text: `Emoji recommendation for the value column (${valueCol})`,
        },
        accessory: {
          type: "static_select",
          action_id: "value_emoji_bar",
          options:
            valueRecs.length > 0
              ? valueRecs.map((e) => ({
                  text: { type: "plain_text", text: e.emoji },
                  value: e.emoji,
                }))
              : [{ text: { type: "plain_text", text: "❓" }, value: "❓" }],
          initial_option:
            valueRecs.length > 0
              ? {
                  text: { type: "plain_text", text: valueRecs[0].emoji },
                  value: valueRecs[0].emoji,
                }
              : { text: { type: "plain_text", text: "❓" }, value: "❓" },
        },
      },
      makeCustomEmojiInput(
        "custom_value_emoji_bar",
        "custom_value_emoji_block_bar",
      ),
      { type: "divider" },
      // Show options
      {
        type: "section",
        block_id: "show_end_emoji_block_bar",
        text: {
          type: "mrkdwn",
          text: "*Show emoji only at the end of each bar?*",
        },
        accessory: {
          type: "checkboxes",
          action_id: "show_end_emoji_checkbox_bar",
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
        block_id: "show_title_block_bar",
        text: { type: "mrkdwn", text: "*Show chart title?*" },
        accessory: {
          type: "checkboxes",
          action_id: "show_title_checkbox_bar",
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
        block_id: "show_legend_block_bar",
        text: { type: "mrkdwn", text: "*Show legend?*" },
        accessory: {
          type: "checkboxes",
          action_id: "show_legend_bar",
          options: [
            {
              text: { type: "plain_text", text: "Show legend" },
              value: "show",
            },
          ],
        },
      },
      // Preview
      {
        type: "section",
        block_id: "preview_block_bar",
        text: { type: "mrkdwn", text: "```\n" + updatedPreview + "\n```" },
      },
    ];

    try {
      await client.views.update({
        external_id: "emoji_chart_modal_bar",
        view: {
          type: "modal",
          callback_id: "post_final_message",
          title: { type: "plain_text", text: "Bar Chart Builder", emoji: true },
          submit: { type: "plain_text", text: "Finish", emoji: true },
          close: { type: "plain_text", text: "Back", emoji: true },
          private_metadata: JSON.stringify({
            ...private_metadata,
            labelCol,
            valueCol,
            labelEmoji,
            valueEmoji,
            preview: updatedPreview,
          }),
          blocks: updatedBlocks,
        },
      });
    } catch (error) {
      console.warn(
        "Skipping bar recommendation modal update:",
        error?.data?.error || error?.message || error,
      );
    }
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
    }),
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
  "custom_label_emoji_svc",
  "low_emoji_svc",
  "custom_low_emoji_svc",
  "medium_emoji_svc",
  "custom_medium_emoji_svc",
  "high_emoji_svc",
  "custom_high_emoji_svc",
  "show_legend_svc",
  "show_title_checkbox_svc",
];

singleValueChartEmojiActions.forEach((actionId) => {
  app.action(actionId, async ({ body, action, ack, client }) => {
    const view = body.view;
    const state = view?.state?.values || {};
    const private_metadata = JSON.parse(view.private_metadata || "{}");

    const rawTableData = private_metadata.rawTableData;
    const labelCol = private_metadata.labelCol;
    const valueCol = private_metadata.valueCol;
    const chartTitle = private_metadata.chartTitle || "";
    const minRange = private_metadata.minRange;
    const maxRange = private_metadata.maxRange;
    const triggeredId = action.action_id;
    const blockId = action.block_id;

    let labelEmoji = private_metadata.labelEmoji || "none";
    let lowEmoji = private_metadata.lowEmoji || "👎";
    let mediumEmoji = private_metadata.mediumEmoji || "😐";
    let highEmoji = private_metadata.highEmoji || "👍";

    let dropdownValue, customValue;

    // --- validate custom emoji input ---
    if (triggeredId.startsWith("custom_")) {
      const customValueRaw = action.value?.trim() || "";
      const isValid = customValueRaw && singleEmojiRegex.test(customValueRaw);
      if (!isValid) {
        await ack({
          response_action: "errors",
          errors: {
            [blockId]: "Please enter exactly one emoji character.",
          },
        });
        return;
      }
    }

    await ack();

    const blocks = [...view.blocks];

    // --- handle dropdown vs custom, clearing custom inputs on dropdown ---
    if (triggeredId === "label_emoji_svc") {
      dropdownValue = action.selected_option?.value;
      labelEmoji = dropdownValue;
      resetCustomEmojiBlock(
        blocks,
        "custom_label_emoji_svc_block",
        "custom_label_emoji_svc",
      );
    } else if (triggeredId === "custom_label_emoji_svc") {
      customValue = action.value?.trim();
      if (customValue) labelEmoji = customValue;
    }

    if (triggeredId === "low_emoji_svc") {
      dropdownValue = action.selected_option?.value;
      lowEmoji = dropdownValue;
      resetCustomEmojiBlock(
        blocks,
        "custom_low_emoji_svc_block",
        "custom_low_emoji_svc",
      );
    } else if (triggeredId === "custom_low_emoji_svc") {
      customValue = action.value?.trim();
      if (customValue) lowEmoji = customValue;
    }

    if (triggeredId === "medium_emoji_svc") {
      dropdownValue = action.selected_option?.value;
      mediumEmoji = dropdownValue;
      resetCustomEmojiBlock(
        blocks,
        "custom_medium_emoji_svc_block",
        "custom_medium_emoji_svc",
      );
    } else if (triggeredId === "custom_medium_emoji_svc") {
      customValue = action.value?.trim();
      if (customValue) mediumEmoji = customValue;
    }

    if (triggeredId === "high_emoji_svc") {
      dropdownValue = action.selected_option?.value;
      highEmoji = dropdownValue;
      resetCustomEmojiBlock(
        blocks,
        "custom_high_emoji_svc_block",
        "custom_high_emoji_svc",
      );
    } else if (triggeredId === "custom_high_emoji_svc") {
      customValue = action.value?.trim();
      if (customValue) highEmoji = customValue;
    }

    const showLegend = readCheckbox(
      state,
      "show_legend_block_svc",
      "show_legend_svc",
    );
    const showTitle = readCheckbox(
      state,
      "show_title_block_svc",
      "show_title_checkbox_svc",
      true,
    );

    const showLabelEmoji = labelEmoji !== "none";

    // --- parse and aggregate ---
    const { headers, rows } = parseTableData(rawTableData);
    const labelIdx = headers.indexOf(labelCol);
    const valueIdx = headers.indexOf(valueCol);
    const agg = aggregateSum(rows, labelIdx, valueIdx);

    // --- build preview ---
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

    const previewIdx = blocks.findIndex(
      (b) => b.block_id === "preview_block_svc",
    );
    if (previewIdx !== -1) {
      blocks[previewIdx] = {
        ...blocks[previewIdx],
        text: { type: "mrkdwn", text: "```\n" + preview + "\n```" },
      };
    }

    const new_private_metadata = JSON.stringify({
      ...private_metadata,
      preview,
      labelEmoji,
      lowEmoji,
      mediumEmoji,
      highEmoji,
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
  const { headers, rows } = parseTableData(rawTableData);
  const labelIdx = headers.indexOf(labelCol);
  const valueIdx = headers.indexOf(valueCol);

  // aggregate values
  const agg = aggregateSum(rows, labelIdx, valueIdx);

  // placeholder preview
  const placeholderPreview = generateSingleValueChartPreview({
    agg,
    labelEmoji: "none",
    lowEmoji: "🟥",
    mediumEmoji: "🟧",
    highEmoji: "🟩",
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
          text: {
            type: "mrkdwn",
            text: "⏳ Generating emoji recommendations...",
          },
        },
        {
          type: "section",
          block_id: "label_emoji_block_svc",
          text: {
            type: "mrkdwn",
            text: `*Label emoji for ${labelCol}*: No label`,
          },
        },
        {
          type: "section",
          block_id: "low_emoji_block_svc",
          text: {
            type: "mrkdwn",
            text: `*Low value emoji for ${valueCol}*: 🟥`,
          },
        },
        {
          type: "section",
          block_id: "medium_emoji_block_svc",
          text: {
            type: "mrkdwn",
            text: `*Medium value emoji for ${valueCol}*: 🟧`,
          },
        },
        {
          type: "section",
          block_id: "high_emoji_block_svc",
          text: {
            type: "mrkdwn",
            text: `*High value emoji for ${valueCol}*: 🟩`,
          },
        },
        {
          type: "section",
          block_id: "show_title_block_svc",
          text: {
            type: "mrkdwn",
            text: "*Show chart title?*\n[x] Show chart title",
          },
        },
        {
          type: "section",
          block_id: "show_legend_block_svc",
          text: {
            type: "mrkdwn",
            text: "*Show legend?*\n[ ] Show legend",
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
            text: "```\n" + placeholderPreview + "\n```",
          },
        },
      ],
    },
  });

  // ---- async update with real recs ----
  runDetached("Single-value recommendation modal update failed", async () => {
    if (!isCurrentTaskMetadata(private_metadata)) {
      logSkippedStaleModalUpdate("single-value", private_metadata.taskId);
      return;
    }
    const tableData = { headers, rows };
    const tableDescription = chartTitle || "Data visualization";

    const suggestions = await recommendEmojis(tableData, tableDescription);
    if (!isCurrentTaskMetadata(private_metadata)) {
      logSkippedStaleModalUpdate("single-value", private_metadata.taskId);
      return;
    }
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
      // Label emoji
      {
        type: "section",
        block_id: `label_emoji_block_svc_${Date.now()}`,
        text: {
          type: "mrkdwn",
          text: `Emoji recommendation for the label column (${labelCol})`,
        },
        accessory: {
          type: "static_select",
          action_id: "label_emoji_svc",
          options: [
            { text: { type: "plain_text", text: "No label" }, value: "none" },
            ...labelRecs.map((e) => ({
              text: { type: "plain_text", text: e.emoji },
              value: e.emoji,
            })),
          ],
          initial_option: {
            text: { type: "plain_text", text: "No label" },
            value: "none",
          },
        },
      },
      makeCustomEmojiInput(
        "custom_label_emoji_svc",
        "custom_label_emoji_svc_block",
      ),
      { type: "divider" },
      // Low emoji
      {
        type: "section",
        block_id: `low_emoji_block_svc_${Date.now()}`,
        text: {
          type: "mrkdwn",
          text: `Low value emoji recommendation for ${valueCol}`,
        },
        accessory: {
          type: "static_select",
          action_id: "low_emoji_svc",
          options: (valueEmojiGroups.low.length > 0
            ? valueEmojiGroups.low
            : [{ emoji: lowEmoji }]
          ).map((e) => ({
            text: { type: "plain_text", text: e.emoji },
            value: e.emoji,
          })),
          initial_option: {
            text: { type: "plain_text", text: lowEmoji },
            value: lowEmoji,
          },
        },
      },
      makeCustomEmojiInput(
        "custom_low_emoji_svc",
        "custom_low_emoji_svc_block",
      ),
      { type: "divider" },
      // Medium emoji
      {
        type: "section",
        block_id: `medium_emoji_block_svc_${Date.now()}`,
        text: {
          type: "mrkdwn",
          text: `Medium value emoji recommendation for ${valueCol}`,
        },
        accessory: {
          type: "static_select",
          action_id: "medium_emoji_svc",
          options: (valueEmojiGroups.medium.length > 0
            ? valueEmojiGroups.medium
            : [{ emoji: mediumEmoji }]
          ).map((e) => ({
            text: { type: "plain_text", text: e.emoji },
            value: e.emoji,
          })),
          initial_option: {
            text: { type: "plain_text", text: mediumEmoji },
            value: mediumEmoji,
          },
        },
      },
      makeCustomEmojiInput(
        "custom_medium_emoji_svc",
        "custom_medium_emoji_svc_block",
      ),
      { type: "divider" },
      // High emoji
      {
        type: "section",
        block_id: `high_emoji_block_svc_${Date.now()}`,
        text: {
          type: "mrkdwn",
          text: `High value emoji recommendation for ${valueCol}`,
        },
        accessory: {
          type: "static_select",
          action_id: "high_emoji_svc",
          options: (valueEmojiGroups.high.length > 0
            ? valueEmojiGroups.high
            : [{ emoji: highEmoji }]
          ).map((e) => ({
            text: { type: "plain_text", text: e.emoji },
            value: e.emoji,
          })),
          initial_option: {
            text: { type: "plain_text", text: highEmoji },
            value: highEmoji,
          },
        },
      },
      makeCustomEmojiInput(
        "custom_high_emoji_svc",
        "custom_high_emoji_svc_block",
      ),
      { type: "divider" },
      // Show title and legend
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
      // Preview
      {
        type: "section",
        block_id: "preview_block_svc",
        text: { type: "mrkdwn", text: "```\n" + updatedPreview + "\n```" },
      },
    ];

    try {
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
            labelEmoji: "none",
            lowEmoji,
            mediumEmoji,
            highEmoji,
            preview: updatedPreview,
          }),
          blocks: updatedBlocks,
        },
      });
    } catch (error) {
      console.warn(
        "Skipping single-value recommendation modal update:",
        error?.data?.error || error?.message || error,
      );
    }
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

  let preview = `${showLabelEmoji ? `${labelEmoji} ` : ""}${labelCol} `;

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
  "custom_label_emoji_tc",
  "low_emoji_tc",
  "custom_low_emoji_tc",
  "medium_emoji_tc",
  "custom_medium_emoji_tc",
  "high_emoji_tc",
  "custom_high_emoji_tc",
  "show_legend_tc",
  "show_title_checkbox_tc",
];

trendChartEmojiActions.forEach((actionId) => {
  app.action(actionId, async ({ body, action, ack, client }) => {
    const view = body.view;
    const state = view?.state?.values || {};
    const private_metadata = JSON.parse(view.private_metadata || "{}");

    const rawTableData = private_metadata.rawTableData;
    const labelCol = private_metadata.labelCol;
    const valueCol = private_metadata.valueCol;
    const chartTitle = private_metadata.chartTitle || "";
    const minRange = private_metadata.minRange;
    const maxRange = private_metadata.maxRange;
    const triggeredId = action.action_id;
    const blockId = action.block_id;

    // defaults
    let labelEmoji = private_metadata.labelEmoji || "none";
    let lowEmoji = private_metadata.lowEmoji || "📉";
    let mediumEmoji = private_metadata.mediumEmoji || "😐";
    let highEmoji = private_metadata.highEmoji || "📈";

    let dropdownValue, customValue;

    // --- validate custom emoji input ---
    if (triggeredId.startsWith("custom_")) {
      const customValueRaw = action.value?.trim() || "";
      const isValid = customValueRaw && singleEmojiRegex.test(customValueRaw);
      if (!isValid) {
        await ack({
          response_action: "errors",
          errors: {
            [blockId]: "Please enter exactly one emoji character.",
          },
        });
        return;
      }
    }

    await ack();

    const blocks = [...view.blocks];

    // --- handle dropdown vs custom ---
    if (triggeredId === "label_emoji_tc") {
      dropdownValue = action.selected_option?.value;
      labelEmoji = dropdownValue;
      resetCustomEmojiBlock(
        blocks,
        "custom_label_emoji_tc_block",
        "custom_label_emoji_tc",
      );
    } else if (triggeredId === "custom_label_emoji_tc") {
      customValue = action.value?.trim();
      if (customValue) labelEmoji = customValue;
    }

    if (triggeredId === "low_emoji_tc") {
      dropdownValue = action.selected_option?.value;
      lowEmoji = dropdownValue;
      resetCustomEmojiBlock(
        blocks,
        "custom_low_emoji_tc_block",
        "custom_low_emoji_tc",
      );
    } else if (triggeredId === "custom_low_emoji_tc") {
      customValue = action.value?.trim();
      if (customValue) lowEmoji = customValue;
    }

    if (triggeredId === "medium_emoji_tc") {
      dropdownValue = action.selected_option?.value;
      mediumEmoji = dropdownValue;
      resetCustomEmojiBlock(
        blocks,
        "custom_medium_emoji_tc_block",
        "custom_medium_emoji_tc",
      );
    } else if (triggeredId === "custom_medium_emoji_tc") {
      customValue = action.value?.trim();
      if (customValue) mediumEmoji = customValue;
    }

    if (triggeredId === "high_emoji_tc") {
      dropdownValue = action.selected_option?.value;
      highEmoji = dropdownValue;
      resetCustomEmojiBlock(
        blocks,
        "custom_high_emoji_tc_block",
        "custom_high_emoji_tc",
      );
    } else if (triggeredId === "custom_high_emoji_tc") {
      customValue = action.value?.trim();
      if (customValue) highEmoji = customValue;
    }

    const showLegend = readCheckbox(
      state,
      "show_legend_block_tc",
      "show_legend_tc",
    );
    const showTitle = readCheckbox(
      state,
      "show_title_block_tc",
      "show_title_checkbox_tc",
      true,
    );

    const showLabelEmoji = labelEmoji !== "none";

    // --- rebuild preview ---
    const { headers, rows } = parseTableData(rawTableData);
    const labelIdx = headers.indexOf(labelCol);
    const valueIdx = headers.indexOf(valueCol);

    const entries = rows
      .map((r) => [r[labelIdx], Number(r[valueIdx])])
      .filter(([_, v]) => !isNaN(v))
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

    const previewIdx = blocks.findIndex(
      (b) => b.block_id === "preview_block_tc",
    );
    if (previewIdx !== -1) {
      blocks[previewIdx] = {
        ...blocks[previewIdx],
        text: { type: "mrkdwn", text: "```\n" + preview + "\n```" },
      };
    }

    const new_private_metadata = JSON.stringify({
      ...private_metadata,
      preview,
      labelEmoji,
      lowEmoji,
      mediumEmoji,
      highEmoji,
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
  const { headers, rows } = parseTableData(rawTableData);
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
    lowEmoji: "🟥",
    mediumEmoji: "🟧",
    highEmoji: "🟩",
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

  const buildFinalTrendModal = ({ valueEmojiGroups, labelRecs }) => {
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
        text: {
          type: "mrkdwn",
          text: `Emoji recommendation for the label column (${labelCol})`,
        },
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
      makeCustomEmojiInput(
        "custom_label_emoji_tc",
        "custom_label_emoji_tc_block",
      ),
      {
        type: "divider",
      },
      {
        type: "section",
        block_id: `low_emoji_block_tc_${Date.now()}`,
        text: {
          type: "mrkdwn",
          text: `Low value emoji recommendation for ${valueCol}`,
        },
        accessory: {
          type: "static_select",
          action_id: "low_emoji_tc",
          options: (valueEmojiGroups.low.length > 0
            ? valueEmojiGroups.low
            : [{ emoji: lowEmoji }]
          ).map((e) => ({
            text: { type: "plain_text", text: e.emoji },
            value: e.emoji,
          })),
          initial_option: {
            text: { type: "plain_text", text: lowEmoji },
            value: lowEmoji,
          },
        },
      },
      makeCustomEmojiInput("custom_low_emoji_tc", "custom_low_emoji_tc_block"),
      {
        type: "divider",
      },
      {
        type: "section",
        block_id: `medium_emoji_block_tc_${Date.now()}`,
        text: {
          type: "mrkdwn",
          text: `Medium value emoji recommendation for ${valueCol}`,
        },
        accessory: {
          type: "static_select",
          action_id: "medium_emoji_tc",
          options: (valueEmojiGroups.medium.length > 0
            ? valueEmojiGroups.medium
            : [{ emoji: mediumEmoji }]
          ).map((e) => ({
            text: { type: "plain_text", text: e.emoji },
            value: e.emoji,
          })),
          initial_option: {
            text: { type: "plain_text", text: mediumEmoji },
            value: mediumEmoji,
          },
        },
      },
      makeCustomEmojiInput(
        "custom_medium_emoji_tc",
        "custom_medium_emoji_tc_block",
      ),
      {
        type: "divider",
      },
      {
        type: "section",
        block_id: `high_emoji_block_tc_${Date.now()}`,
        text: {
          type: "mrkdwn",
          text: `High value emoji recommendation for ${valueCol}`,
        },
        accessory: {
          type: "static_select",
          action_id: "high_emoji_tc",
          options: (valueEmojiGroups.high.length > 0
            ? valueEmojiGroups.high
            : [{ emoji: highEmoji }]
          ).map((e) => ({
            text: { type: "plain_text", text: e.emoji },
            value: e.emoji,
          })),
          initial_option: {
            text: { type: "plain_text", text: highEmoji },
            value: highEmoji,
          },
        },
      },
      makeCustomEmojiInput(
        "custom_high_emoji_tc",
        "custom_high_emoji_tc_block",
      ),
      {
        type: "divider",
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

    return {
      preview: updatedPreview,
      lowEmoji,
      mediumEmoji,
      highEmoji,
      blocks: updatedBlocks,
    };
  };

  if (getActiveVariant() !== "semantic") {
    const valueEmojiGroups = getRecEmojiOptions({}, valueCol, "scale");
    const labelRecs = getRecEmojiOptions({}, labelCol, "column_name");
    const finalModal = buildFinalTrendModal({ valueEmojiGroups, labelRecs });

    await ack({
      response_action: "push",
      view: {
        type: "modal",
        external_id: "emoji_chart_modal_trend",
        callback_id: "post_final_message",
        private_metadata: JSON.stringify({
          ...private_metadata,
          labelCol,
          valueCol,
          minRange,
          maxRange,
          labelEmoji: "none",
          lowEmoji: finalModal.lowEmoji,
          mediumEmoji: finalModal.mediumEmoji,
          highEmoji: finalModal.highEmoji,
          preview: finalModal.preview,
        }),
        title: { type: "plain_text", text: "Trend Chart", emoji: true },
        submit: { type: "plain_text", text: "Finish", emoji: true },
        close: { type: "plain_text", text: "Back", emoji: true },
        blocks: transformBlocksForVariant(finalModal.blocks),
      },
    });
    return;
  }

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
          text: {
            type: "mrkdwn",
            text: `*Choose emoji for ${labelCol}:* No label`,
          },
        },
        {
          type: "section",
          block_id: "low_emoji_block_tc",
          text: {
            type: "mrkdwn",
            text: `*Low value emoji for ${valueCol}:* 🟥`,
          },
        },
        {
          type: "section",
          block_id: "medium_emoji_block_tc",
          text: {
            type: "mrkdwn",
            text: `*Medium value emoji for ${valueCol}:* 🟧`,
          },
        },
        {
          type: "section",
          block_id: "high_emoji_block_tc",
          text: {
            type: "mrkdwn",
            text: `*High value emoji for ${valueCol}:* 🟩`,
          },
        },
        {
          type: "section",
          block_id: "show_title_block_tc",
          text: {
            type: "mrkdwn",
            text: "*Show chart title?*\n[x] Show chart title",
          },
        },
        {
          type: "section",
          block_id: "show_legend_block_tc",
          text: {
            type: "mrkdwn",
            text: "*Show legend?*\n[ ] Show legend",
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
  runDetached("Trend recommendation modal update failed", async () => {
    if (!isCurrentTaskMetadata(private_metadata)) {
      logSkippedStaleModalUpdate("trend", private_metadata.taskId);
      return;
    }
    const tableData = { headers, rows };
    const tableDescription = chartTitle || "Data visualization";

    const suggestions = await recommendEmojis(tableData, tableDescription);
    if (!isCurrentTaskMetadata(private_metadata)) {
      logSkippedStaleModalUpdate("trend", private_metadata.taskId);
      return;
    }
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
        text: {
          type: "mrkdwn",
          text: `Emoji recommendation for the label column (${labelCol})`,
        },
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
      makeCustomEmojiInput(
        "custom_label_emoji_tc",
        "custom_label_emoji_tc_block",
      ),
      {
        type: "divider",
      },
      {
        type: "section",
        block_id: `low_emoji_block_tc_${Date.now()}`,
        text: {
          type: "mrkdwn",
          text: `Low value emoji recommendation for ${valueCol}`,
        },
        accessory: {
          type: "static_select",
          action_id: "low_emoji_tc",
          options: (valueEmojiGroups.low.length > 0
            ? valueEmojiGroups.low
            : [{ emoji: lowEmoji }]
          ).map((e) => ({
            text: { type: "plain_text", text: e.emoji },
            value: e.emoji,
          })),
          initial_option: {
            text: { type: "plain_text", text: lowEmoji },
            value: lowEmoji,
          },
        },
      },
      makeCustomEmojiInput("custom_low_emoji_tc", "custom_low_emoji_tc_block"),
      {
        type: "divider",
      },
      {
        type: "section",
        block_id: `medium_emoji_block_tc_${Date.now()}`,
        text: {
          type: "mrkdwn",
          text: `Medium value emoji recommendation for ${valueCol}`,
        },
        accessory: {
          type: "static_select",
          action_id: "medium_emoji_tc",
          options: (valueEmojiGroups.medium.length > 0
            ? valueEmojiGroups.medium
            : [{ emoji: mediumEmoji }]
          ).map((e) => ({
            text: { type: "plain_text", text: e.emoji },
            value: e.emoji,
          })),
          initial_option: {
            text: { type: "plain_text", text: mediumEmoji },
            value: mediumEmoji,
          },
        },
      },
      makeCustomEmojiInput(
        "custom_medium_emoji_tc",
        "custom_medium_emoji_tc_block",
      ),
      {
        type: "divider",
      },
      {
        type: "section",
        block_id: `high_emoji_block_tc_${Date.now()}`,
        text: {
          type: "mrkdwn",
          text: `High value emoji recommendation for ${valueCol}`,
        },
        accessory: {
          type: "static_select",
          action_id: "high_emoji_tc",
          options: (valueEmojiGroups.high.length > 0
            ? valueEmojiGroups.high
            : [{ emoji: highEmoji }]
          ).map((e) => ({
            text: { type: "plain_text", text: e.emoji },
            value: e.emoji,
          })),
          initial_option: {
            text: { type: "plain_text", text: highEmoji },
            value: highEmoji,
          },
        },
      },
      makeCustomEmojiInput(
        "custom_high_emoji_tc",
        "custom_high_emoji_tc_block",
      ),
      {
        type: "divider",
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

    try {
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
            labelEmoji: "none",
            lowEmoji,
            mediumEmoji,
            highEmoji,
            preview: updatedPreview,
          }),
          blocks: updatedBlocks,
        },
      });
    } catch (error) {
      console.warn(
        "Skipping trend recommendation modal update:",
        error?.data?.error || error?.message || error,
      );
    }
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
      1,
    );
    emojiSlots.push(...Array(slotCount).fill(emoji));
  }

  // fill remaining space
  if (emojiSlots.length < totalSlots) {
    emojiSlots.push(
      ...Array(totalSlots - emojiSlots.length).fill(defaultEmoji),
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
          `${emojiMap[label.toLowerCase()] || defaultEmoji} = ${label}`,
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
  "por_label_emoji_other",
  "custom_por_label_emoji_other",
  ...Array.from({ length: 5 }, (_, i) => `por_label_emoji_${i}`),
  ...Array.from({ length: 5 }, (_, i) => `custom_por_label_emoji_${i}`),
];

proportionChartEmojiActions.forEach((actionId) => {
  app.action(actionId, async ({ body, action, ack, client }) => {
    const view = body.view;
    const state = view?.state?.values || {};
    const private_metadata = JSON.parse(view.private_metadata || "{}");

    const rawTableData = private_metadata.rawTableData;
    const labelCol = private_metadata.labelCol;
    const chartTitle = private_metadata.chartTitle || "";
    const emojiMap = { ...private_metadata.emojiMap };
    const otherEmoji = private_metadata.otherEmoji || "📦";
    const freqCol = private_metadata.freqCol || "none";
    const triggeredId = action.action_id;
    const blockId = action.block_id;

    let idx, labelText, dropdownValue, customValue;

    const inputMatch = triggeredId.match(/^custom_por_label_emoji_(\d+)$/);
    const dropdownMatch = triggeredId.match(/^por_label_emoji_(\d+)$/);
    const isOtherInput = triggeredId === "custom_por_label_emoji_other";
    const isOtherDropdown = triggeredId === "por_label_emoji_other";

    // --- validate custom emoji input ---
    if (inputMatch || isOtherInput) {
      const customValueRaw = action.value?.trim() || "";
      const isValid = customValueRaw && singleEmojiRegex.test(customValueRaw);
      if (!isValid) {
        await ack({
          response_action: "errors",
          errors: {
            [blockId]: "Please enter exactly one emoji character.",
          },
        });
        return;
      }
    }

    await ack();

    // --- Dropdowns clear their paired custom inputs ---
    if (dropdownMatch) {
      idx = dropdownMatch[1];
      labelText = private_metadata.labels[idx];
      dropdownValue = action.selected_option?.value;

      const blocks = [...view.blocks];
      const customBlockIdx = blocks.findIndex((b) =>
        b.block_id.startsWith(`custom_label_emoji_block_${idx}`),
      );
      if (customBlockIdx !== -1) {
        blocks[customBlockIdx] = {
          ...blocks[customBlockIdx],
          block_id: `custom_label_emoji_block_${idx}_reset_${Date.now()}`,
          element: {
            ...blocks[customBlockIdx].element,
            initial_value: "", // force reset
          },
        };
      }
      view.blocks = blocks;
      customValue = undefined;
    } else if (inputMatch) {
      idx = inputMatch[1];
      labelText = private_metadata.labels[idx];
      customValue = action.value?.trim();

      const dropdownBlock = state[`label_emoji_block_${idx}`];
      dropdownValue =
        dropdownBlock?.[`por_label_emoji_${idx}`]?.selected_option?.value;
    } else if (isOtherDropdown) {
      labelText = "other";
      dropdownValue = action.selected_option?.value;

      const blocks = [...view.blocks];
      const customBlockIdx = blocks.findIndex((b) =>
        b.block_id.startsWith("custom_label_emoji_block_other"),
      );
      if (customBlockIdx !== -1) {
        blocks[customBlockIdx] = {
          ...blocks[customBlockIdx],
          block_id: `custom_label_emoji_block_other_reset_${Date.now()}`,
          element: {
            ...blocks[customBlockIdx].element,
            initial_value: "", // clear custom override
          },
        };
      }
      view.blocks = blocks;
      customValue = undefined;
    } else if (isOtherInput) {
      labelText = "other";
      customValue = action.value?.trim();

      const dropdownBlock = state["label_emoji_block_other"];
      dropdownValue =
        dropdownBlock?.por_label_emoji_other?.selected_option?.value;
    }

    // --- update emoji map ---
    if (labelText) {
      if (customValue) {
        emojiMap[labelText.toLowerCase()] = customValue;
      } else if (dropdownValue) {
        emojiMap[labelText.toLowerCase()] = dropdownValue;
      }
    }

    // --- regenerate preview (unchanged logic) ---
    const showLegend = readCheckbox(
      state,
      "show_legend_block_por",
      "show_legend_por",
    );
    const showTitle = readCheckbox(
      state,
      "show_title_block_por",
      "show_title_checkbox_por",
      true,
    );

    const { headers, rows } = parseTableData(rawTableData);
    const labelIdx = headers.indexOf(labelCol);
    const freqIdx = freqCol !== "none" ? headers.indexOf(freqCol) : -1;
    const agg = aggregateFrequency(rows, labelIdx, freqIdx);

    const formattedPreview = generateProportionChartPreview({
      agg,
      emojiMap,
      chartTitle,
      showTitle,
      showLegend,
      numEmojisPerLine:
        Number(
          state.num_emojis_per_line_block?.num_emojis_per_line_input?.value,
        ) || 10,
      defaultEmoji: emojiMap["other"] || otherEmoji,
    });

    const blocks = [...view.blocks];
    const previewIdx = blocks.findIndex(
      (b) => b.block_id === "preview_block_por",
    );
    if (previewIdx !== -1) {
      blocks[previewIdx] = {
        ...blocks[previewIdx],
        text: { type: "mrkdwn", text: "```\n" + formattedPreview + "\n```" },
      };
    }

    const new_private_metadata = JSON.stringify({
      ...private_metadata,
      emojiMap,
      preview: formattedPreview,
      otherEmoji: emojiMap["other"] || otherEmoji,
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
    const { headers, rows } = parseTableData(rawTableData);
    const labelIdx = headers.indexOf(labelCol);
    const freqIdx = freqCol !== "none" ? headers.indexOf(freqCol) : -1;

    // count frequency of each label
    const agg = aggregateFrequency(rows, labelIdx, freqIdx);

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
          ?.value,
      ) || 10;

    const formattedPreview = generateProportionChartPreview({
      agg,
      emojiMap: placeholderEmojiMap,
      chartTitle,
      showTitle,
      showLegend,
      numEmojisPerLine,
      defaultEmoji: "⬜️",
    });

    const new_private_metadata = JSON.stringify({
      ...private_metadata,
      labelCol,
      preview: formattedPreview,
      emojiMap: placeholderEmojiMap,
      freqCol,
      labels: topFive,
    });

    // ---- load modal with placeholders ----
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
              text: `*Choose an emoji for each unique value in the label column (${labelCol})*`,
            },
          },
          ...topFive.map((label, i) => ({
            type: "section",
            block_id: `label_emoji_block_${i}`,
            text: {
              type: "mrkdwn",
              text: `${label}: ❓`,
            },
          })),
          {
            type: "section",
            block_id: `label_emoji_block_other_por`,
            text: {
              type: "mrkdwn",
              text: `Other: ❓`,
            },
          },
          {
            type: "section",
            block_id: "show_title_block_por",
            text: {
              type: "mrkdwn",
              text: "*Show chart title?*\n[x] Show chart title",
            },
          },
          {
            type: "section",
            block_id: "show_legend_block_por",
            text: {
              type: "mrkdwn",
              text: "*Show legend?*\n[x] Show legend",
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
    runDetached("Proportion recommendation modal update failed", async () => {
      if (!isCurrentTaskMetadata(private_metadata)) {
        logSkippedStaleModalUpdate("proportion", private_metadata.taskId);
        return;
      }
      const tableData = { headers, rows };
      const tableDescription = chartTitle || "Data visualization";
      const realEmojiMap = {};
      const suggestions = await recommendEmojis(tableData, tableDescription);
      if (!isCurrentTaskMetadata(private_metadata)) {
        logSkippedStaleModalUpdate("proportion", private_metadata.taskId);
        return;
      }

      for (const label of topFive) {
        const recs = getRecEmojiOptions(
          suggestions,
          labelCol, // the column name
          "value", // we want categorical value recommendations
          label, // the actual categorical value
        );

        realEmojiMap[label] = recs[0]?.emoji || "❓";
      }

      // In the placeholder condition the "Other" category gets a single distinct
      // non-semantic mark (drawn from the same per-chart nominal sequence as the
      // top-five categories) so there is nothing to choose; the other conditions
      // keep the hardcoded list of generic symbols.
      const otherPlaceholder =
        getActiveVariant() === "placeholder"
          ? nominalPlaceholderFor(`${labelCol}::value::__other__`)
          : null;
      const otherEmojiOptions = otherPlaceholder
        ? [{ emoji: otherPlaceholder }]
        : [
            { emoji: "⬜️" }, // options for the "Other" category are hardcoded for now
            { emoji: "⬛️" },
            { emoji: "⚪" },
            { emoji: "⚫" },
            { emoji: "✨" },
            { emoji: "📦" },
            { emoji: "❔" },
          ];
      const otherInitialEmoji = otherPlaceholder || "⬜️";

      // Fill "Other" slots in the preview with the same mark shown as the
      // "Other" dropdown's selected value so the graph text matches the control.
      const updatedPreview = generateProportionChartPreview({
        agg,
        emojiMap: realEmojiMap,
        chartTitle,
        showTitle,
        showLegend,
        numEmojisPerLine,
        defaultEmoji: otherInitialEmoji,
      });

      const updatedBlocks = [
        {
          type: "section",
          block_id: "label_emoji_block_por",
          text: {
            type: "mrkdwn",
            text: `*Choose an emoji for each unique value in the label column (${labelCol})*`,
          },
        },
        {
          type: "divider",
        },
        ...topFive
          .map((label, i) => {
            const recs = getRecEmojiOptions(
              suggestions,
              labelCol,
              "value",
              label,
            );

            return [
              {
                type: "section",
                block_id: `label_emoji_block_${i}`,
                text: {
                  type: "mrkdwn",
                  text: `Emoji recommendation for ${label}`,
                },
                accessory: {
                  type: "static_select",
                  action_id: `por_label_emoji_${i}`,
                  // Always provide at least one option: when the backend returns
                  // no recommendation for this value, fall back to the resolved
                  // emoji (realEmojiMap[label], "❓" on failure) so Slack never
                  // rejects an empty static_select.
                  options: (recs.length > 0
                    ? recs
                    : [{ emoji: realEmojiMap[label] }]
                  ).map((e) => ({
                    text: { type: "plain_text", text: e.emoji },
                    value: e.emoji,
                  })),
                  initial_option: {
                    text: { type: "plain_text", text: realEmojiMap[label] },
                    value: realEmojiMap[label],
                  },
                },
              },
              {
                type: "input",
                block_id: `custom_label_emoji_block_${i}`,
                label: {
                  type: "plain_text",
                  text: `Override with a custom emoji`,
                },
                element: {
                  type: "plain_text_input",
                  action_id: `custom_por_label_emoji_${i}`,
                  initial_value: "",
                  placeholder: {
                    type: "plain_text",
                    text: "Type a custom emoji to override",
                  },
                },
                dispatch_action: true,
                optional: true,
              },
              {
                type: "divider",
              },
            ];
          })
          .flat(),
        {
          type: "section",
          block_id: `label_emoji_block_other`,
          text: {
            type: "mrkdwn",
            text: `Emoji recommendation for Other`,
          },
          accessory: {
            type: "static_select",
            action_id: `por_label_emoji_other`,
            options: otherEmojiOptions.map((e) => ({
              text: { type: "plain_text", text: e.emoji },
              value: e.emoji,
            })),
            initial_option: {
              text: { type: "plain_text", text: otherInitialEmoji },
              value: otherInitialEmoji,
            },
          },
        },
        {
          type: "input",
          block_id: `custom_label_emoji_block_other`,
          label: {
            type: "plain_text",
            text: `Override with a custom emoji`,
          },
          element: {
            type: "plain_text_input",
            action_id: `custom_por_label_emoji_other`,
            initial_value: "",
            placeholder: {
              type: "plain_text",
              text: "Type a custom emoji to override",
            },
          },
          dispatch_action: true,
          optional: true,
        },
        {
          type: "divider",
        },
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

      try {
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
              labels: topFive,
              otherEmoji: otherInitialEmoji, // default for "Other" category
            }),
            blocks: updatedBlocks,
          },
        });
      } catch (error) {
        console.warn(
          "Skipping proportion recommendation modal update:",
          error?.data?.error || error?.message || error,
        );
      }
    });
  },
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

  // Finalize study measurements for this task (timing + acceptance/override).
  // Wrapped so a logging failure can never affect the participant's session.
  try {
    await finalizeTask({
      view,
      private_metadata,
      postedBy: body.user.id,
    });
  } catch (error) {
    console.error("Error finalizing study task log:", error);
  }
});

// Start Bolt app (Slackbot in socket mode)
// Only start the servers when run directly (e.g. `npm run start`); when this
// module is imported (e.g. by tests) we skip startup so no Slack/port binding
// occurs.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  (async () => {
    await app.start();
    console.log("⚡️ Emoji Encoder is running!");
    console.log(`[study] Active interface variant: ${STUDY_VARIANT}`);
  })();

  // Express for Render port binding
  const expressApp = express();
  expressApp.get("/", (req, res) => {
    res.send("Emoji Encoder Slackbot is running on express!");
  });

  const port = process.env.PORT || 3000;
  expressApp.listen(port, () => {
    console.log(`Express server listening on port ${port}`);
  });
}

export {
  recommendEmojis,
  getRecEmojiOptions,
  STUDY_VARIANT,
  studySession,
  getActiveVariant,
  getStudyContext,
  startTask,
  finalizeTask,
  resetPlaceholderAssignments,
  PLACEHOLDER_NOMINAL_EMOJIS,
  PLACEHOLDER_SCALE_EMOJIS,
};
