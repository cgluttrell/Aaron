import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type {
  IncognitoSessionFacts,
  IncognitoSessionOperations,
} from "./session-incognito-contract.js";
import type { IncognitoHistoryOperations } from "./session-incognito-history-contract.js";

export type IncognitoHistoryCommand = SqliteWorkerCommand<IncognitoHistoryOperations>;

export type PreparedHistoryRead<Key extends IncognitoHistoryCommand["type"]> = {
  type: Key;
  read(facts: IncognitoSessionFacts[]): IncognitoSessionOperations[Key]["output"];
};

export function prepareHistoryRead<Key extends IncognitoHistoryCommand["type"]>(
  type: Key,
  read: () => IncognitoHistoryOperations[Key]["output"],
): PreparedHistoryRead<Key>;
export function prepareHistoryRead(
  type: IncognitoHistoryCommand["type"],
  read: () => IncognitoHistoryOperations[IncognitoHistoryCommand["type"]]["output"],
) {
  return {
    type,
    read: (facts: IncognitoSessionFacts[]) => ({ value: read(), facts }),
  };
}
