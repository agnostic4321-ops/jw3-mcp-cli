/**
 * Authenticated MCP passthroughs: connections, diary, risk, propose.
 * Read-only except propose, which queues a Diary setup for in-app
 * approve-and-sign — never executes.
 *
 * One module per command under ./extra/; this barrel preserves the
 * `./commands/extra.js` import path for index.ts.
 */
export { cmdConnections } from "./extra/connections.js";
export { cmdDailyPrep, dailyPrepParams } from "./extra/daily-prep.js";
export { cmdDiary } from "./extra/diary.js";
export { cmdDiaryNote, validateDiaryNote } from "./extra/diary-note.js";
export type { DiaryNoteArgs } from "./extra/diary-note.js";
export { cmdNews, newsParams } from "./extra/news.js";
export { cmdPropose, validatePropose } from "./extra/propose.js";
export type { ProposeArgs } from "./extra/propose.js";
export { cmdRisk, formatRiskState } from "./extra/risk.js";
