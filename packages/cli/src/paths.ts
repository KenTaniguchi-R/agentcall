import os from "node:os";
import { join } from "node:path";

/** Every path owned by one AgentCall installation and its single identity. */
export interface Paths {
  userHome: string;
  stateRoot: string;
  dir: string;
  configFile: string;
  contactsFile: string;
  knownPeersFile: string;
  replayReservationsFile: string;
  listenerLog: string;
  identityKeyFile: string;
  policyFile: string;
  scopeFile: string;
  cardSnapshotFile: string;
  callsLog: string;
  toolsLog: string;
  tasksDir: string;
  shareDir: string;
  contextsFile: string;
  contextsOutFile: string;
  recoveryPendingFile: string;
  outboundJobsFile: string;
  executionJournalFile: string;
}

export function getPaths(
  stateRoot: string = process.env.AGENTCALL_HOME ?? os.homedir(),
  userHome: string = os.homedir(),
): Paths {
  const dir = join(stateRoot, ".agentcall");
  const authored = join(userHome, "AgentCall");
  return {
    userHome,
    stateRoot,
    dir,
    configFile: join(dir, "config.json"),
    contactsFile: join(dir, "contacts.json"),
    knownPeersFile: join(dir, "known_peers.json"),
    replayReservationsFile: join(dir, "replay_reservations.json"),
    listenerLog: join(dir, "listener.log"),
    identityKeyFile: join(dir, "identity.key.json"),
    policyFile: join(dir, "policy.json"),
    scopeFile: join(dir, "scope.json"),
    cardSnapshotFile: join(dir, "card.pushed.json"),
    callsLog: join(dir, "calls.log"),
    toolsLog: join(dir, "tools.log"),
    tasksDir: join(authored, "tasks"),
    shareDir: join(authored, "public"),
    contextsFile: join(dir, "contexts.json"),
    contextsOutFile: join(dir, "contexts-out.json"),
    recoveryPendingFile: join(dir, "recovery-pending.json"),
    outboundJobsFile: join(dir, "outbound-jobs.json"),
    executionJournalFile: join(dir, "execution-journal.json"),
  };
}
