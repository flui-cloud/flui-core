/* eslint-disable @typescript-eslint/no-require-imports */
import agentToolNote = require('./agent-tool-note.json');
import systemReminder = require('./system-reminder.json');
import continuationReminder = require('./continuation-reminder.json');

// Model-facing behavior policy, authored as data in this directory and bundled at build
// time. Kept out of the KB corpus (that is product knowledge) and out of the service code
// (these are tunable rules, not logic). Each file is a list of lines joined into one block.
export const AGENT_TOOL_NOTE = agentToolNote.lines.join('\n');
export const SYSTEM_REMINDER = systemReminder.lines.join('\n');
export const CONTINUATION_REMINDER = continuationReminder.lines.join('\n');
