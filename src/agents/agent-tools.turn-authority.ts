import {
  gateAgentToolExecution,
  markAgentToolExecutionUnavailable,
} from "./agent-tool-availability.js";
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import type { AnyAgentTool } from "./tools/common.js";

/**
 * Offers the session's tool surface on every turn, so the provider prompt prefix
 * stays cacheable, and gates the calls this turn's authority does not cover.
 */
export function resolveTurnToolSurface(params: {
  turnTools: AnyAgentTool[];
  sessionTools?: AnyAgentTool[];
  ownerOnlyDenied: ReadonlySet<string>;
  withheld?: AnyAgentTool;
}) {
  const turnAuthorizedNames = new Set(
    params.turnTools
      .filter((tool) => !params.ownerOnlyDenied.has(tool.name))
      .map((tool) => tool.name),
  );
  const turnAuthorized = (tool: { name: string }) => turnAuthorizedNames.has(tool.name);
  const offered = (params.sessionTools ?? params.turnTools).filter(
    (tool) => tool !== params.withheld,
  );
  const tools = offered.map((tool) => {
    if (turnAuthorized(tool)) {
      return tool;
    }
    const gated = gateAgentToolExecution(
      tool,
      params.ownerOnlyDenied.has(tool.name)
        ? `${tool.name} needs the owner's authority, and this turn was not started by the owner. Do not retry ${tool.name}.`
        : `${tool.name} is outside the authority this completion turn carries from its requester. Do not retry ${tool.name}.`,
    );
    return markAgentToolExecutionUnavailable(copyAgentToolMetadata(tool, gated));
  });
  return {
    tools,
    turnAuthorized,
    exportedTools: params.turnTools.filter(turnAuthorized),
    callableTools: offered.filter(turnAuthorized),
  };
}
