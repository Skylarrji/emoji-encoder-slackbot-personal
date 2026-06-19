// Offline mock of @slack/bolt used by the run-sheet test harness.
//
// It records every handler app.js registers (command / action / view) and the
// middleware passed to app.use, so the test can invoke the REAL handler code
// from app.js without a Slack connection. App.start() is a no-op, so importing
// app.js never opens a socket or binds a port.

export const registry = {
  commands: new Map(), // "/setup" -> handler
  views: new Map(), // "study_setup_modal" -> handler
  actions: new Map(), // "insight_input" -> handler
  middlewares: [], // app.use(...) callbacks
  errorHandler: null,
  options: { lastConstructed: null },
};

export class App {
  constructor(opts = {}) {
    registry.options.lastConstructed = opts;
  }
  command(name, handler) {
    registry.commands.set(name, handler);
  }
  action(id, handler) {
    registry.actions.set(id, handler);
  }
  view(id, handler) {
    registry.views.set(id, handler);
  }
  use(mw) {
    registry.middlewares.push(mw);
  }
  error(handler) {
    registry.errorHandler = handler;
  }
  async start() {
    /* no-op: never connect in tests */
  }
  async stop() {
    /* no-op */
  }
}

export default { App };
