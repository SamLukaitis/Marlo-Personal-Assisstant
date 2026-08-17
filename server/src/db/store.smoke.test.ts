import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, getUser } from "./store.js";

describe("store smoke test", () => {
  it("creates and reads back a user, confirming the isolated test DB is wired up", () => {
    const user = findOrCreateUserByEmail("smoke-test@example.com");
    expect(user.email).toBe("smoke-test@example.com");
    const fetched = getUser(user.id);
    expect(fetched?.email).toBe("smoke-test@example.com");
  });
});
