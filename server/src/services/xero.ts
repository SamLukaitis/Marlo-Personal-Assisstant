import { getSetting, setSetting } from "../db/store.js";

// Same shape as the email check in whatsappRegistration.ts — good enough to catch a typo/garbage
// input, not meant to be a full RFC 5322 validator.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function getXeroForwardingEmail(ownerId: number): string | null {
  return getSetting(ownerId, "xero_forwarding_email");
}

export function setXeroForwardingEmail(ownerId: number, email: string): void {
  const trimmed = email.trim();
  if (!EMAIL_RE.test(trimmed)) {
    throw new Error(`"${email}" doesn't look like a valid email address.`);
  }
  setSetting(ownerId, "xero_forwarding_email", trimmed);
}
