import type { AgentCardType, EncryptionKeyRecordType, IdentityRecordType } from "@benree/agentcall-shared";
import { fetchCard, fetchKeys, getStatus, type Auth } from "./api.js";
import { authOf } from "./api.js";
import { loadInstallation, relayUrl, type Installation } from "./config.js";
import { loadContacts, resolveAddress, type Resolved } from "./contacts.js";
import { inspectPeerIdentity, type PeerIdentityInspection } from "./known-peers.js";
import type { Paths } from "./paths.js";

type KeyBundle = { identity: IdentityRecordType; encryption: { record: EncryptionKeyRecordType; signature: string } };
type ContactBook = ReturnType<typeof loadContacts>;

export interface PeerInspectionIO {
  loadInstallation(paths: Paths): Installation;
  resolveAddress(paths: Paths, value: string, org?: string): Resolved;
  loadContacts(paths: Paths): ContactBook;
  getStatus(relay: string, handle: string, auth: Auth): Promise<{ online: boolean }>;
  fetchKeys(relay: string, auth: Auth, handle: string): Promise<KeyBundle>;
  fetchCard(relay: string, handle: string, auth: Auth): Promise<AgentCardType>;
  inspectIdentity(paths: Paths, address: string, bundle: KeyBundle): Promise<PeerIdentityInspection>;
}

export type PeerInspection = {
  address: string;
  contact?: { name: string; note?: string };
  availability: { state: "online" | "offline" | "undisclosed" | "unavailable"; detail?: string };
  identity: PeerIdentityInspection | { state: "unavailable"; detail: string };
  card: { state: "available"; value: AgentCardType } | { state: "missing" } | { state: "unavailable"; detail: string };
  next_command: string;
};

const defaults: PeerInspectionIO = {
  loadInstallation,
  resolveAddress,
  loadContacts,
  getStatus,
  fetchKeys,
  fetchCard,
  inspectIdentity: inspectPeerIdentity,
};

const detail = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function inspectPeer(target: string, paths: Paths, io: PeerInspectionIO = defaults): Promise<PeerInspection> {
  const installation = io.loadInstallation(paths);
  const resolved = io.resolveAddress(paths, target, installation.config.org);
  if (!resolved.ok) throw new Error(resolved.error);

  const contact = io.loadContacts(paths).contacts.find((entry) =>
    entry.name.toLowerCase() === target.toLowerCase() || entry.address === resolved.address);
  const relay = relayUrl(installation.config);
  const auth = authOf(installation.config);
  const self = resolved.handle === installation.config.handle;

  const availabilityPromise = self
    ? io.getStatus(relay, resolved.handle, auth)
        .then(({ online }) => ({ state: online ? "online" : "offline" } as const))
        .catch((error) => ({ state: "unavailable" as const, detail: detail(error) }))
    : Promise.resolve({ state: "undisclosed" as const });
  const identityPromise = io.fetchKeys(relay, auth, resolved.handle)
    .then((bundle) => io.inspectIdentity(paths, resolved.address, bundle))
    .catch((error) => ({ state: "unavailable" as const, detail: detail(error) }));
  const cardPromise = io.fetchCard(relay, resolved.handle, auth)
    .then((value) => ({ state: "available" as const, value }))
    .catch((error: unknown) => (error as { code?: string })?.code === "unknown_handle"
      ? { state: "missing" as const }
      : { state: "unavailable" as const, detail: detail(error) });

  const [availability, identity, card] = await Promise.all([availabilityPromise, identityPromise, cardPromise]);
  const task = card.state === "available" ? card.value.tasks[0]?.id : undefined;
  return {
    address: resolved.address,
    ...(contact ? { contact: { name: contact.name, ...(contact.note ? { note: contact.note } : {}) } } : {}),
    availability,
    identity,
    card,
    next_command: task
      ? `agentcall call ${resolved.address} --task ${task} "<message>"`
      : `agentcall call ${resolved.address} "<message>"`,
  };
}

export function inspectionExitCode(result: PeerInspection): number {
  if (result.identity.state === "changed" || result.identity.state === "invalid" || result.identity.state === "unavailable") return 1;
  if (result.availability.state === "unavailable" || result.card.state === "unavailable") return 1;
  if (result.availability.state === "offline") return 2;
  if (result.card.state === "missing") return 3;
  return 0;
}
