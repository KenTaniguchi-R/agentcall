import {
  HpkeEnvelope, keyIdFor, type A2ATaskType, type E2EEOutcomeType,
} from "@benree/agentcall-shared";
import { openE2EEResponse } from "./e2ee.js";
import { loadEncryptionKeysForEpoch } from "./keys.js";
import { findOutboundJob } from "./outbound-jobs.js";
import type { Paths } from "./paths.js";

const RESULT_MEDIA_TYPE = "application/vnd.agentcall.hpke+json";

export async function decryptJobOutcome(
  paths: Paths, address: string, task: A2ATaskType,
): Promise<E2EEOutcomeType | undefined> {
  const job = findOutboundJob(paths, address, task.id);
  if (!job) throw new Error("No matching local outbound job was found; refusing an unbound artifact.");
  const rawPart = task.artifacts?.flatMap((artifact) => artifact.parts)
    .find((part): part is { raw: string; mediaType: string } => "raw" in part && part.mediaType === RESULT_MEDIA_TYPE);
  if (!rawPart) return undefined;

  let rawEnvelope: unknown;
  try {
    rawEnvelope = JSON.parse(Buffer.from(rawPart.raw, "base64").toString("utf8"));
  } catch {
    throw new Error("The durable result artifact is not a valid encrypted envelope.");
  }
  const envelope = HpkeEnvelope.parse(rawEnvelope);
  const localKeys = loadEncryptionKeysForEpoch(paths, envelope.epoch);
  const response = await openE2EEResponse(
    envelope,
    localKeys.encryption_pkcs8,
    job.recipient_identity_pub,
    {
      relay_origin: job.frame.envelope.relay_origin,
      from: job.frame.envelope.to,
      to: job.frame.envelope.from,
      key_id: await keyIdFor(localKeys.encryption_pub),
      epoch: localKeys.epoch,
    },
    {
      message_id: job.message_id,
      request_id: job.request_id,
      request_transcript_hash: job.request_transcript_hash,
      delivery_mode: "durable",
    },
  );
  return response.outcome;
}
