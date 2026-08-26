import { runAdapter } from "../../common/src/adapter-contract";
import { runPostEditHook, runPreEditHook, runRecordCommand, runSessionStartHook } from "./gate-command";

export { mapHostEvent, runAdapter } from "../../common/src/adapter-contract";
export { RecorderBridge } from "../../common/src/bridge";
export { checkPostToolUse, checkPreToolUse, handleSessionStart, recordDecision } from "./gate-command";

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "pre-edit") {
    await runPreEditHook();
  } else if (command === "post-edit") {
    await runPostEditHook();
  } else if (command === "record") {
    await runRecordCommand();
  } else if (command === "session-start") {
    await runSessionStartHook();
  } else {
    await runAdapter("claude-code", process.stdin, process.stdout);
  }
}
