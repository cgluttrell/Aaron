import type { AgentMessage } from "../../types.js";
import { projectSessionEntryMessage } from "../session/session.js";
import type { SessionTreeEntry } from "../types.js";
import {
  findLatestCompactionUserMessage,
  formatCompactionUserLabel,
  formatFileOperations,
  getCompactionContent,
} from "./utils.js";

function projectCompactionRequestEntry(entry: SessionTreeEntry): AgentMessage | undefined {
  return entry.type === "compaction" ? undefined : projectSessionEntryMessage(entry);
}

/** Select the admitted request and later updates without reviving an older independent ask. */
export function selectCompactionRequestMessages(
  pathEntries: SessionTreeEntry[],
  requestEntryId: string | undefined,
): { messages: AgentMessage[]; hasRequestInput: boolean } | undefined {
  const admittedIndex = requestEntryId
    ? pathEntries.findIndex((entry) => entry.id === requestEntryId)
    : -1;
  const admittedEntry = pathEntries[admittedIndex];
  if (
    requestEntryId &&
    (!admittedEntry || projectCompactionRequestEntry(admittedEntry)?.role !== "user")
  ) {
    return undefined;
  }
  const projected = (admittedIndex >= 0 ? pathEntries.slice(admittedIndex) : pathEntries).flatMap(
    (entry) => {
      const message = projectCompactionRequestEntry(entry);
      return message ? [message] : [];
    },
  );
  const latestInput = projected.findLast((message) => message.role === "user");
  const messages = admittedIndex >= 0 ? projected : latestInput ? [latestInput] : [];
  return { messages, hasRequestInput: messages.some((message) => message.role === "user") };
}

export function latestCompactionUserText(messages: AgentMessage[]): string {
  const message = findLatestCompactionUserMessage(
    messages,
    (candidate) => getCompactionContent(candidate.content).text,
  );
  return message ? getCompactionContent(message.content).text.trim() : "";
}

export function formatSplitTurnSourceAsk(messages: AgentMessage[]): string {
  const message = messages.findLast(
    (candidate): candidate is Extract<AgentMessage, { role: "user" }> =>
      candidate.role === "user" && Boolean(getCompactionContent(candidate.content).text.trim()),
  );
  if (!message) {
    return "";
  }
  const text = getCompactionContent(message.content).text;
  const label = formatCompactionUserLabel(message);
  return label === "User" ? text : `[${label}]: ${text}`;
}

/** Remove metadata that finalization regenerates from the current compaction state. */
export function stripPreviousCompactionMetadata(
  previousSummary: string | undefined,
  details:
    | { readFiles: string[]; modifiedFiles: string[]; latestUnresolvedUserRequest?: string }
    | undefined,
): string | undefined {
  const requestSection = details?.latestUnresolvedUserRequest
    ? `## Latest unresolved user request\n${JSON.stringify(details.latestUnresolvedUserRequest)}\n\n`
    : "";
  const summary =
    requestSection && previousSummary?.includes(requestSection)
      ? previousSummary.replace(requestSection, "")
      : previousSummary;
  const fileOperations = details
    ? formatFileOperations(details.readFiles, details.modifiedFiles)
    : "";
  return fileOperations && summary?.endsWith(fileOperations)
    ? summary.slice(0, -fileOperations.length)
    : summary;
}
