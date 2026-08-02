import { CardUpload } from "@benree/agentcall-shared";

type StoredCard = ReturnType<typeof CardUpload.parse>;

// Stored cards were valid when written, but a later schema tightening can
// make a legacy row unreadable. Treat that row as unavailable at every read
// boundary and log only identifying metadata — never the card or validation
// message, both of which can contain user-authored content.
export function parseStoredCard(cardJson: string, org: string, handle: string): StoredCard | null {
  try {
    return CardUpload.parse(JSON.parse(cardJson));
  } catch (error) {
    console.error("invalid stored card", {
      org,
      handle,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}
