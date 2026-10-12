// Settings uses hasSlot to decide whether to show its own instructions or hand
// the section to an overlay (e.g. a hosted deployment's SMTP form replacing the
// self-hosted "set SMTP_* environment variables" hint).

import { describe, expect, test } from "bun:test";
import { hasSlot, registerSlot } from "@/components/layout/slot-registry";

describe("slot registry", () => {
  test("hasSlot is false until something is registered into that slot", () => {
    expect(hasSlot("settings-email")).toBe(false);
    registerSlot("settings-email", "overlay smtp form");
    expect(hasSlot("settings-email")).toBe(true);
    expect(hasSlot("login-footer")).toBe(false);
  });
});
