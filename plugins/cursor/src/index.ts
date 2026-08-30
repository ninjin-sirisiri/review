import { runAdapter } from "../../common/src/adapter-contract";
import {
  runPostEditHook,
  runPreEditHook,
  runRecordCommand,
  runSessionStartHook,
} from "./gate";
import { runMcpServer } from "./mcp";

export { mapHostEvent, runAdapter } from "../../common/src/adapter-contract";
export { RecorderBridge } from "../../common/src/bridge";
export {
  AGENT_TYPE,
  checkPostToolUse,
  checkPreToolUse,
  handleSessionStart,
  recordDecision,
  registerSession,
  sessionStartOutput,
} from "./gate";
export { dispatchMcpMessage } from "./mcp";

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
  } else if (command === "mcp") {
    await runMcpServer();
  } else {
    await runAdapter("cursor", process.stdin, process.stdout);
  }
}
