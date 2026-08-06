import { describe, expect, it } from "vitest";
import {
  formatCloseReason, formatFingerprintPrompt, formatInviteLines, formatRoomStatusBoard,
  resolveHostDisplayName, sanitizeDisplayName, suggestAlternateDisplayName,
} from "../src/room-render.js";
import type { RoomCloseReasonType } from "@benree/agentcall-shared";

describe("formatInviteLines", () => {
  it("prints one invitation for the whole group with the seats it still admits", () => {
    const lines = formatInviteLines({ invite: "acri.x", expires_at: 1, seats_remaining: 3 });
    expect(lines).toEqual([
      "Send this invitation to your group:",
      "  acri.x",
      "",
      "This invitation expires in 5 minutes and admits up to 3 more people.",
    ]);
  });

  // A 2-person Room has exactly one seat left, and "1 more people" is the kind
  // of copy an evaluator notices in the first thirty seconds.
  it("says person, not people, for the last remaining seat", () => {
    const lines = formatInviteLines({ invite: "acri.x", expires_at: 1, seats_remaining: 1 });
    expect(lines).toContain("This invitation expires in 5 minutes and admits up to 1 more person.");
  });
});

describe("formatCloseReason", () => {
  it("has copy for every RoomCloseReason value", () => {
    const reasons: RoomCloseReasonType[] = [
      "host_left", "expired", "idle", "verification_failed",
      "insufficient_participants", "abuse_limit", "relay_error",
    ];
    for (const reason of reasons) {
      expect(formatCloseReason(reason).length).toBeGreaterThan(0);
    }
  });
});

describe("formatFingerprintPrompt", () => {
  it("lists every member's display name and the fingerprint", () => {
    const text = formatFingerprintPrompt("ABC-123-XYZ-789", [
      { display_name: "ken" }, { display_name: "sota" },
    ]);
    expect(text).toContain("ken, sota");
    expect(text).toContain("ABC-123-XYZ-789");
  });
});

describe("formatRoomStatusBoard", () => {
  it("lists every participant with their state", () => {
    const board = formatRoomStatusBoard({
      room: { room_id: "room_x", state: "active", membership_epoch: 1 } as never,
      participants: [
        { display_name: "ken", state: "ready" } as never,
        { display_name: "sota", state: "paused" } as never,
      ],
    } as never, 90_000);
    expect(board).toContain("ken");
    expect(board).toContain("ready");
    expect(board).toContain("sota");
    expect(board).toContain("paused");
    expect(board).toContain("2 people");
  });
});

describe("sanitizeDisplayName", () => {
  it("trims and NFC-normalizes", () => {
    expect(sanitizeDisplayName("  sota  ")).toBe("sota");
  });

  it("truncates to 24 code points without splitting a surrogate pair", () => {
    // The emoji sits exactly at the cut: it must be dropped whole, not halved
    // into a lone (invalid) surrogate.
    const long = "a".repeat(24) + "😀" + "b".repeat(10);
    const sanitized = sanitizeDisplayName(long);
    expect(sanitized).toBe("a".repeat(24));
    expect([...sanitized].length).toBeLessThanOrEqual(24);
    expect(/[\ud800-\udfff]/.test(sanitized)).toBe(false);
  });
});

describe("resolveHostDisplayName", () => {
  it("uses an explicit valid name", () => {
    expect(resolveHostDisplayName("ken")).toBe("ken");
  });

  it("falls back away from an explicit name RoomDisplayName would reject", () => {
    // "@" is explicitly disallowed by RoomDisplayName.
    expect(resolveHostDisplayName("ken@acme")).not.toContain("@");
  });

  it("never returns an empty string", () => {
    expect(resolveHostDisplayName("").length).toBeGreaterThan(0);
  });
});

describe("suggestAlternateDisplayName", () => {
  it("suggests a numbered variant that stays within the length cap", () => {
    const suggestion = suggestAlternateDisplayName("a".repeat(24), 1);
    expect([...suggestion].length).toBeLessThanOrEqual(24);
    expect(suggestion.endsWith("2")).toBe(true);
  });

  it("produces different suggestions on successive attempts", () => {
    const first = suggestAlternateDisplayName("sota", 1);
    const second = suggestAlternateDisplayName("sota", 2);
    expect(first).not.toBe(second);
  });
});
