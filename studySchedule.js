// ===========================================================================
// Study schedule (Latin square)  —  EDIT THIS FILE TO LOCK YOUR DESIGN
// ===========================================================================
// This file encodes the counterbalanced assignment of CONDITIONS to the three
// chart-creation tasks. The bot reads it so the research assistant (URA) never
// has to choose a condition by hand: they enter the participant's number, and
// the bot auto-advances through that participant's row.
//
// HOW THE LATIN SQUARE WORKS
//   - There are 3 creation tasks, presented in a FIXED order (Task 1, 2, 3).
//     Each task has a fixed chart type / dataset / scenario; only the CONDITION
//     rotates across participants.
//   - CONDITION_SQUARE has one row per participant GROUP. A participant's group
//     is ((participantNumber - 1) % number_of_rows). Each row lists the
//     condition used for Task 1, Task 2, Task 3 respectively.
//   - The rows below are a balanced 3x3 Latin square: each condition appears
//     once per row, and once in each task position across the three rows.
//
// TO LOCK YOUR DESIGN (Phase 0):
//   1. Set the chart type / dataset / scenario for each of the 3 TASKS below.
//   2. Confirm the CONDITION_SQUARE rows match the Schedule tab in your Google
//      Sheet (they must agree exactly — this file is the source of truth).
//   3. Assign each recruited participant a sequential number (1, 2, 3, ...).
//      Participant N uses row ((N - 1) % 3).
// ===========================================================================

// The three creation tasks, in the fixed order they are presented to every
// participant. Only `condition` rotates (via the Latin square); everything else
// here is held constant across participants for that task slot.
export const TASKS = [
  {
    position: 1,
    chartType: "bar",
    datasetTopic: "Coffee drink sales by drink (coffee_sales.csv)",
    scenario:
      "You are sharing this week's coffee sales in a Slack update to your café team so they can see at a glance which drinks sold the most.",
  },
  {
    position: 2,
    chartType: "proportion",
    datasetTopic: "Most-purchased fruit market share (fruit.csv)",
    scenario:
      "You are posting in a grocery buyers' Slack channel to show what share of total fruit purchases each fruit made up last month.",
  },
  {
    position: 3,
    chartType: "trend",
    datasetTopic:
      "Ice-cream sales by month across the year (icecream_sales.csv)",
    scenario:
      "You are sending a Slack message to your shop's owners to show how ice-cream sales rose and fell across the seasons over the past year.",
  },
];

// Latin square of CONDITIONS. Row = participant group; column = task position.
// Valid condition values: "manual", "placeholder", "semantic".
export const CONDITION_SQUARE = [
  ["manual", "placeholder", "semantic"], // group 0: participants 1, 4, 7, ...
  ["placeholder", "semantic", "manual"], // group 1: participants 2, 5, 8, ...
  ["semantic", "manual", "placeholder"], // group 2: participants 3, 6, 9, ...
];

const VALID_CONDITIONS = ["manual", "placeholder", "semantic"];

// Validate the square at load time so a typo fails loudly instead of silently
// corrupting a participant's condition assignment.
function validateSquare() {
  const errors = [];
  CONDITION_SQUARE.forEach((row, r) => {
    if (row.length !== TASKS.length) {
      errors.push(
        `Row ${r} has ${row.length} conditions but there are ${TASKS.length} tasks.`,
      );
    }
    row.forEach((c, col) => {
      if (!VALID_CONDITIONS.includes(c)) {
        errors.push(`Row ${r}, task ${col + 1}: invalid condition "${c}".`);
      }
    });
    // Each condition should appear exactly once per row (balanced within-subject).
    const unique = new Set(row);
    if (unique.size !== row.length) {
      errors.push(`Row ${r} repeats a condition: [${row.join(", ")}].`);
    }
  });
  if (errors.length) {
    throw new Error(
      "[studySchedule] Invalid CONDITION_SQUARE:\n  " + errors.join("\n  "),
    );
  }
}
validateSquare();

// Build the ordered list of tasks for a given participant NUMBER (1-based).
// Returns an array of { position, condition, chartType, datasetTopic, scenario }.
// Throws on a non-positive-integer number so the modal can show a clear error.
export function getParticipantSchedule(participantNumber) {
  const n = Number(participantNumber);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `Participant number must be a positive integer (got "${participantNumber}").`,
    );
  }
  const row = CONDITION_SQUARE[(n - 1) % CONDITION_SQUARE.length];
  return TASKS.map((task, i) => ({
    position: task.position,
    condition: row[i],
    chartType: task.chartType,
    datasetTopic: task.datasetTopic,
    scenario: task.scenario,
  }));
}

// Human-readable one-line summary of a participant's row, for logging / status.
export function describeSchedule(participantNumber) {
  return getParticipantSchedule(participantNumber)
    .map((t) => `T${t.position}:${t.chartType}/${t.condition}`)
    .join("  ");
}
