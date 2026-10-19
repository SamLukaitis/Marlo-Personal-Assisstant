// What a user calls each kind of mailbox in a message: "your Gmail", "your Outlook".
export function mailboxLabel(provider: string): string {
  return provider === "microsoft" ? "Outlook" : "Gmail";
}
