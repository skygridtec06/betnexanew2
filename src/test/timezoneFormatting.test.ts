import { describe, it, expect } from "vitest";
import { formatDateTimeForDisplayEAT } from "@/lib/timezoneFormatter";

describe("bet timestamp formatting", () => {
  it("converts UTC bet timestamps to East Africa Time for display", () => {
    const formatted = formatDateTimeForDisplayEAT("2026-08-25T10:33:00.000Z");

    expect(formatted.date).toBe("25/08/2026");
    expect(formatted.time).toBe("01:33 PM");
  });
});
