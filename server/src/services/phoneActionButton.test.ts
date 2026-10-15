import { describe, it, expect } from "vitest";
import { actionButtonFor } from "./phoneActionButton.js";
import { SERVER_URL } from "../config.js";

const link = `${SERVER_URL}/a/kLflvrBG4C_8kJzkdVGZ3A`;

describe("actionButtonFor", () => {
  it("turns a reply with one action link into button text + url", () => {
    expect(actionButtonFor(`Tap to set a 7:00 alarm:\n${link}`)).toEqual({ body: "Tap to set a 7:00 alarm:", url: link });
  });

  it("keeps the sentence around an inline link readable", () => {
    expect(actionButtonFor(`Tap to send it: ${link} — iOS will ask you to confirm.`)).toEqual({
      body: "Tap to send it: — iOS will ask you to confirm.",
      url: link,
    });
  });

  it("gives a default body when the reply is only the link", () => {
    expect(actionButtonFor(link)).toEqual({ body: "Tap to run this on your iPhone.", url: link });
  });

  it("leaves replies with no action link, or more than one, as plain text", () => {
    expect(actionButtonFor("No link here.")).toBeNull();
    expect(actionButtonFor(`${link}\n${SERVER_URL}/a/RoDQOFOrJ0StqRRI7jBTNQ`)).toBeNull();
  });

  it("leaves a body too long for a WhatsApp button as plain text", () => {
    expect(actionButtonFor(`${"x".repeat(1100)}\n${link}`)).toBeNull();
  });
});
