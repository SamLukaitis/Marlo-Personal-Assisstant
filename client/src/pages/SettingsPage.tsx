import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  fetchProviders,
  fetchAccounts,
  disconnectAccount,
  updateAccountPermissions,
  loginUrl,
  fetchLocalFolders,
  addLocalFolder,
  removeLocalFolder,
  fetchBriefingSettings,
  saveBriefingSettings,
  fetchMemoryNotes,
  addMemoryNote,
  removeMemoryNote,
  fetchWhatsAppStatus,
  fetchWhatsAppAllowedNumbers,
  saveWhatsAppAllowedNumbers,
  fetchAlertSettings,
  saveAlertSettings,
  fetchImportantEmailAlertSettings,
  saveImportantEmailAlertSettings,
  fetchInvites,
  addInvite,
  removeInvite,
  fetchWaitlist,
  dismissWaitlistRequest,
  resetTestPhone,
  replayOnboarding,
  fetchAdminMessages,
  fetchSettings,
  saveSettings,
  DEFAULT_BRIEFING_SETTINGS,
  type ProviderInfo,
  type Account,
  type LocalFolder,
  type BriefingSettings,
  type MemoryNote,
  type WhatsAppStatus,
  type AlertSettings,
  type ImportantEmailAlertSettings,
  type InvitedPhone,
  type WaitlistRequest,
  type AdminTimelineEntry,
} from "../api/client";
import { IconTrash, IconPlus, IconRefresh } from "../components/icons";
import { useTools } from "../context/ToolsContext";
import { useAuth } from "../context/AuthContext";
import { BriefingSourcePicker } from "../components/BriefingSourcePicker";

// Sign-in failures are the user's problem to understand, not their sysadmin's — these say what
// happened and what to do, with no reference to how the server is wired up.
const ERROR_TEXT: Record<string, string> = {
  google_not_configured: "Google sign-in isn't available at the moment. Try another provider.",
  microsoft_not_configured:
    "Microsoft sign-in isn't available at the moment. Try another provider.",
  oauth_failed: "That sign-in didn't go through. Try again.",
  missing_code: "That sign-in was cancelled.",
};

const SECTIONS = [
  { key: "accounts", label: "Accounts" },
  { key: "assistant", label: "Assistant" },
  { key: "briefing", label: "Briefing" },
  { key: "messaging", label: "Messaging" },
  { key: "tools", label: "Tools" },
  { key: "files", label: "Files" },
  // Only ever shown/reachable for admins (the app owner plus anyone promoted in the Portal) —
  // filtered out of the nav and refused a redirect target for everyone else, see
  // visibleSections/section below.
  { key: "admin", label: "Admin" },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

// A real, exhaustive list of IANA zone names the browser itself knows about — the human picks
// directly from this, so there's no free text and nothing to mis-resolve. Computed once at
// module load, not per-render: it's a pure function of the runtime, never changes while the page
// is open.
const IANA_TIMEZONES = Intl.supportedValuesOf("timeZone");

function isSectionKey(value: string | null): value is SectionKey {
  return !!value && SECTIONS.some((s) => s.key === value);
}

export function SettingsPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [folders, setFolders] = useState<LocalFolder[]>([]);
  const [newFolder, setNewFolder] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<BriefingSettings>(DEFAULT_BRIEFING_SETTINGS);
  const [briefingSaved, setBriefingSaved] = useState(false);
  const [memoryNotes, setMemoryNotes] = useState<MemoryNote[]>([]);
  const [newNote, setNewNote] = useState("");
  const [timezone, setTimezone] = useState("");
  const [timezoneSaved, setTimezoneSaved] = useState(false);
  const [timezoneError, setTimezoneError] = useState<string | null>(null);
  const [whatsAppStatus, setWhatsAppStatus] = useState<WhatsAppStatus>({
    configured: false,
    signatureConfigured: false,
  });
  const [allowedNumbers, setAllowedNumbers] = useState<string[]>([]);
  const [newNumber, setNewNumber] = useState("");
  const [numbersSaved, setNumbersSaved] = useState(false);
  const [alertSettings, setAlertSettings] = useState<AlertSettings>({ enabled: false });
  const [alertSaved, setAlertSaved] = useState(false);
  const [importantEmailSettings, setImportantEmailSettings] = useState<ImportantEmailAlertSettings>({
    enabled: true,
  });
  const [importantEmailSaved, setImportantEmailSaved] = useState(false);
  const [invites, setInvites] = useState<InvitedPhone[]>([]);
  const [newInvite, setNewInvite] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [invitesLoaded, setInvitesLoaded] = useState(false);
  const [waitlist, setWaitlist] = useState<WaitlistRequest[]>([]);
  const [waitlistLoaded, setWaitlistLoaded] = useState(false);
  const [resetPhone, setResetPhone] = useState("");
  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [replayMessage, setReplayMessage] = useState<string | null>(null);
  const [viewerPhone, setViewerPhone] = useState("");
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [viewerTimeline, setViewerTimeline] = useState<AdminTimelineEntry[] | null>(null);

  const { tools, setEnabled } = useTools();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const visibleSections = SECTIONS.filter((s) => s.key !== "admin" || user?.isAdmin);

  const sectionParam = searchParams.get("section");
  // A non-admin can't land on "admin" even by pasting the URL — falls back the same as an
  // unrecognized section would.
  const section: SectionKey =
    isSectionKey(sectionParam) && (sectionParam !== "admin" || user?.isAdmin)
      ? sectionParam
      : "accounts";

  function goToSection(next: SectionKey) {
    const params = new URLSearchParams(searchParams);
    params.set("section", next);
    // replace: switching settings sections shouldn't stack up back-button history.
    setSearchParams(params, { replace: true });
  }

  async function load() {
    const [p, a, f, b, m, ws, nums, al, iel, s] = await Promise.all([
      fetchProviders(),
      fetchAccounts(),
      fetchLocalFolders(),
      fetchBriefingSettings(),
      fetchMemoryNotes(),
      fetchWhatsAppStatus(),
      fetchWhatsAppAllowedNumbers(),
      fetchAlertSettings(),
      fetchImportantEmailAlertSettings(),
      fetchSettings(),
    ]);
    setProviders(p);
    setAccounts(a);
    setFolders(f);
    setBriefing(b);
    setMemoryNotes(m);
    setWhatsAppStatus(ws);
    setAllowedNumbers(nums);
    setAlertSettings(al);
    setImportantEmailSettings(iel);
    setTimezone(s.timezone ?? "");
  }

  useEffect(() => {
    load().catch(() => {});
  }, []);

  // Separate from load(): fetching this for every user would just draw a guaranteed 403 from
  // adminRoutes.ts for the vast majority of them, for a section they'll never see.
  useEffect(() => {
    if (!user?.isAdmin) return;
    fetchInvites()
      .then(setInvites)
      .catch(() => {})
      .finally(() => setInvitesLoaded(true));
    fetchWaitlist()
      .then(setWaitlist)
      .catch(() => {})
      .finally(() => setWaitlistLoaded(true));
  }, [user?.isAdmin]);

  const connected = searchParams.get("connected");
  const errorKey = searchParams.get("error");

  async function handleAddFolder(e: React.FormEvent) {
    e.preventDefault();
    if (!newFolder.trim()) return;
    setFolderError(null);
    try {
      await addLocalFolder(newFolder.trim());
      setNewFolder("");
      load();
    } catch (err) {
      setFolderError((err as Error).message);
    }
  }

  async function handleAddNote(e: React.FormEvent) {
    e.preventDefault();
    if (!newNote.trim()) return;
    await addMemoryNote(newNote.trim());
    setNewNote("");
    load();
  }

  async function handleSaveBriefing() {
    await saveBriefingSettings(briefing);
    setBriefingSaved(true);
    setTimeout(() => setBriefingSaved(false), 2500);
  }

  async function handleSaveTimezone() {
    setTimezoneError(null);
    try {
      await saveSettings({ timezone: timezone.trim() });
      setTimezoneSaved(true);
      setTimeout(() => setTimezoneSaved(false), 2500);
    } catch (err) {
      setTimezoneError((err as Error).message);
    }
  }

  async function handleToggleAlerts(enabled: boolean) {
    const next = { enabled };
    setAlertSettings(next);
    await saveAlertSettings(next);
    setAlertSaved(true);
    setTimeout(() => setAlertSaved(false), 2500);
  }

  async function handleToggleImportantEmailAlerts(enabled: boolean) {
    const next = { enabled };
    setImportantEmailSettings(next);
    await saveImportantEmailAlertSettings(next);
    setImportantEmailSaved(true);
    setTimeout(() => setImportantEmailSaved(false), 2500);
  }

  async function handleAddInvite(e: React.FormEvent) {
    e.preventDefault();
    const phone = newInvite.trim();
    if (!phone) return;
    setInviteError(null);
    try {
      setInvites(await addInvite(phone));
      setNewInvite("");
      // Approving clears that number's waitlist entry server-side, so the list below has to be
      // refetched — otherwise a number just invited still shows as waiting.
      setWaitlist(await fetchWaitlist().catch(() => waitlist));
    } catch (err) {
      setInviteError((err as Error).message);
    }
  }

  // Approving from the waitlist is the same call as typing the number into the invite box — the
  // server notices it was waiting, clears the entry, and messages them that they're in.
  async function handleApproveWaitlist(phone: string) {
    setInviteError(null);
    try {
      setInvites(await addInvite(phone));
      setWaitlist(await fetchWaitlist().catch(() => waitlist));
    } catch (err) {
      setInviteError((err as Error).message);
    }
  }

  async function handleDismissWaitlist(phone: string) {
    if (!window.confirm(`Dismiss the request from ${phone}? They won't be told anything.`)) return;
    setInviteError(null);
    try {
      setWaitlist(await dismissWaitlistRequest(phone));
    } catch (err) {
      setInviteError((err as Error).message);
    }
  }

  async function handleRemoveInvite(phone: string) {
    try {
      setInvites(await removeInvite(phone));
    } catch (err) {
      setInviteError((err as Error).message);
    }
  }

  async function handleResetTestPhone(e: React.FormEvent) {
    e.preventDefault();
    const phone = resetPhone.trim();
    if (!phone) return;
    if (
      !window.confirm(
        `This permanently deletes any account connected to ${phone} — every mail account, document, and setting. Continue?`
      )
    ) {
      return;
    }
    setResetting(true);
    setResetMessage(null);
    try {
      const result = await resetTestPhone(phone);
      setResetMessage(
        result.hadAccount
          ? `Done — the account behind ${phone} was fully deleted. Message it again to sign up from scratch.`
          : `Done — no account was bound to ${phone} yet, but any half-finished registration for it is cleared.`
      );
      setResetPhone("");
    } catch (err) {
      setResetMessage((err as Error).message);
    } finally {
      setResetting(false);
    }
  }

  async function handleReplayOnboarding() {
    if (
      !window.confirm(
        "This reconnects your mail/calendar via OAuth again and replays the setup questions, but keeps everything already on your portal (usage, to-dos, poster board, documents, memory). Continue?"
      )
    ) {
      return;
    }
    setReplaying(true);
    setReplayMessage(null);
    try {
      const result = await replayOnboarding();
      setReplayMessage(
        result.unboundPhones.length > 0
          ? `Done — message Marlowe from ${result.unboundPhones.join(", ")} to walk through onboarding again. Your existing data is untouched.`
          : "Done — no phone was bound yet, but the connection is cleared."
      );
    } catch (err) {
      setReplayMessage((err as Error).message);
    } finally {
      setReplaying(false);
    }
  }

  async function handleLoadConversation(e: React.FormEvent) {
    e.preventDefault();
    const phone = viewerPhone.trim();
    if (!phone) return;
    setViewerLoading(true);
    setViewerError(null);
    setViewerTimeline(null);
    try {
      const { timeline } = await fetchAdminMessages(phone);
      setViewerTimeline(timeline);
    } catch (err) {
      setViewerError((err as Error).message);
    } finally {
      setViewerLoading(false);
    }
  }

  async function handleToggleTool(key: (typeof tools)[number]["key"], enabled: boolean) {
    try {
      await setEnabled(key, enabled);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function handleTogglePermission(
    accountId: number,
    field: "canRead" | "canSend" | "canDelete",
    value: boolean
  ) {
    await updateAccountPermissions(accountId, { [field]: value });
    load();
  }

  // Replaces the number rather than adding to it — only one WhatsApp number is supported per
  // account (server-enforced too, see whatsappSettingsRoutes.ts): every number on this list gets
  // every proactive alert, not just a message-in permission, so letting the list grow silently
  // led to a stale old number and, in one real case, someone else's number both still receiving
  // an account's private alerts indefinitely. This form only renders when there's no number set
  // (see below) — remove the current one first to set a new one.
  async function handleAddNumber(e: React.FormEvent) {
    e.preventDefault();
    if (!newNumber.trim()) return;
    const next = [newNumber.trim()];
    setAllowedNumbers(next);
    setNewNumber("");
    await saveWhatsAppAllowedNumbers(next);
    setNumbersSaved(true);
    setTimeout(() => setNumbersSaved(false), 2500);
    load();
  }

  async function handleRemoveNumber(number: string) {
    const next = allowedNumbers.filter((n) => n !== number);
    setAllowedNumbers(next);
    await saveWhatsAppAllowedNumbers(next);
  }

  return (
    <div className="main scrollable">
      <div className="main-inner scrollable">
        <div className="page-header">
          <h1 className="heading-font">Settings</h1>
        </div>

        {connected && <div className="banner-note">Connected {connected} successfully.</div>}
        {errorKey && <p className="error">{ERROR_TEXT[errorKey] ?? "That didn't work. Try again."}</p>}

        <div className="settings-layout">
          <nav className="settings-nav">
            {visibleSections.map((s) => (
              <button
                key={s.key}
                className={`settings-nav-item${s.key === section ? " active" : ""}`}
                onClick={() => goToSection(s.key)}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="settings-panel">
            {section === "accounts" && (
              <>
                <h2>Connected accounts</h2>
                <p className="settings-section-intro">
                  Mail, calendar, and files your assistant can read. Connect as many as you like.
                </p>
                <div className="card card-padded" style={{ marginBottom: 20 }}>
                  {accounts.length === 0 && <p className="muted">Nothing connected yet.</p>}
                  {accounts.map((a) => {
                    const providerInfo = providers.find((p) => p.provider === a.provider);
                    return (
                      <div key={a.id} className="data-row" style={{ display: "block" }}>
                        <div className="row" style={{ justifyContent: "space-between" }}>
                          <div>
                            <strong>{a.email}</strong>{" "}
                            <span className="badge-pill" style={{ textTransform: "capitalize" }}>
                              {a.provider}
                            </span>
                          </div>
                          <div className="row" style={{ gap: 8 }}>
                            {a.authBroken && providerInfo && (
                              <a href={loginUrl(providerInfo.loginPath)}>
                                <button className="btn-secondary">Reconnect</button>
                              </a>
                            )}
                            <button
                              className="btn-danger"
                              onClick={async () => {
                                await disconnectAccount(a.id);
                                load();
                              }}
                            >
                              Disconnect
                            </button>
                          </div>
                        </div>
                        {a.authBroken && (
                          <p className="error" style={{ marginTop: 8, marginBottom: 0, fontSize: 13 }}>
                            Sign-in expired
                            {a.authBrokenAt
                              ? ` on ${new Date(a.authBrokenAt).toLocaleDateString()}`
                              : ""}
                            . Reconnect to bring this account's mail, calendar, and files back.
                          </p>
                        )}
                        <div className="row" style={{ gap: 16, marginTop: 10, flexWrap: "wrap" }}>
                          <label className="check-row" style={{ width: "auto" }}>
                            <input
                              type="checkbox"
                              checked={a.canRead}
                              onChange={(e) => handleTogglePermission(a.id, "canRead", e.target.checked)}
                            />
                            <span className="check-row-title">Read</span>
                          </label>
                          {a.provider === "google" && (
                            <label className="check-row" style={{ width: "auto" }}>
                              <input
                                type="checkbox"
                                checked={a.canSend}
                                onChange={(e) => handleTogglePermission(a.id, "canSend", e.target.checked)}
                              />
                              <span className="check-row-title">Send</span>
                            </label>
                          )}
                          <label className="check-row" style={{ width: "auto" }}>
                            <input
                              type="checkbox"
                              checked={a.canDelete}
                              onChange={(e) => handleTogglePermission(a.id, "canDelete", e.target.checked)}
                            />
                            <span className="check-row-title">Delete (archive)</span>
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <h2>Add an account</h2>
                {providers.map((p) => (
                  <div
                    key={p.provider}
                    className="card card-padded row"
                    style={{ justifyContent: "space-between", marginBottom: 8 }}
                  >
                    <div>
                      <strong>{p.label}</strong>
                      <div className="muted">
                        {p.configured
                          ? "Connect as many accounts as you need."
                          : "Not available at the moment."}
                      </div>
                    </div>
                    {p.configured ? (
                      <a href={loginUrl(p.loginPath)}>
                        <button className="btn-primary">Connect</button>
                      </a>
                    ) : (
                      <button className="btn-secondary" disabled>
                        Unavailable
                      </button>
                    )}
                  </div>
                ))}
              </>
            )}

            {section === "assistant" && (
              <>
                <h2>Name and personality</h2>
                <p className="settings-section-intro">
                  Your assistant's name and how it should behave now live next to the assistant
                  itself — open the Assistant page and use Configure.
                </p>
                <div className="card card-padded" style={{ marginBottom: 20 }}>
                  <Link to="/assistant">
                    <button className="btn-secondary">Go to the Assistant</button>
                  </Link>
                </div>

                <h2>Timezone</h2>
                <p className="settings-section-intro">
                  Used to work out what time "3pm" or "in 20 minutes" actually means when you ask
                  for a reminder. Leave unset to let it work this out the moment you share your
                  location with it on WhatsApp — picking one here does the same thing, just now
                  rather than then.
                </p>
                <div className="card card-padded" style={{ marginBottom: 20 }}>
                  <div className="row">
                    <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                      <option value="">Not set</option>
                      {IANA_TIMEZONES.map((tz) => (
                        <option key={tz} value={tz}>
                          {tz}
                        </option>
                      ))}
                    </select>
                    <button className="btn-primary" onClick={handleSaveTimezone}>
                      Save
                    </button>
                  </div>
                  {timezoneSaved && (
                    <p className="muted" style={{ marginTop: 8 }}>
                      Saved.
                    </p>
                  )}
                  {timezoneError && (
                    <p className="error" style={{ marginTop: 8 }}>
                      {timezoneError}
                    </p>
                  )}
                </div>

                <h2>What it remembers</h2>
                <p className="settings-section-intro">
                  Things your assistant keeps in mind across conversations. It adds to this on its
                  own — you can add or remove anything here.
                </p>
                <div className="card card-padded" style={{ marginBottom: 20 }}>
                  <form className="row" onSubmit={handleAddNote}>
                    <input
                      value={newNote}
                      onChange={(e) => setNewNote(e.target.value)}
                      placeholder="e.g. Acme is my priority business"
                    />
                    <button className="btn-primary" type="submit">
                      <IconPlus />
                      Add
                    </button>
                  </form>
                  {memoryNotes.length === 0 ? (
                    <p className="muted" style={{ marginTop: 12 }}>
                      Nothing remembered yet.
                    </p>
                  ) : (
                    memoryNotes.map((n) => (
                      <div key={n.id} className="data-row row" style={{ justifyContent: "space-between" }}>
                        <span style={{ fontSize: 13.5 }}>{n.content}</span>
                        <button
                          className="btn-danger"
                          onClick={async () => {
                            await removeMemoryNote(n.id);
                            load();
                          }}
                        >
                          <IconTrash />
                          Forget
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}

            {section === "briefing" && (
              <>
                <h2>Daily briefing</h2>
                <p className="settings-section-intro">
                  A summary waiting for you at the top of the Assistant page each morning.
                </p>
                <div className="card card-padded" style={{ marginBottom: 20 }}>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={briefing.enabled}
                      onChange={(e) =>
                        setBriefing((prev) => ({ ...prev, enabled: e.target.checked }))
                      }
                    />
                    <span>
                      <span className="check-row-title">Show my daily briefing</span>
                      <span className="check-row-desc">
                        Unread mail, today's calendar, and anything that looks like it needs a
                        reply.
                      </span>
                    </span>
                  </label>

                  {briefing.enabled && (
                    <>
                      <div style={{ height: 8 }} />
                      <BriefingSourcePicker value={briefing} onChange={setBriefing} />

                      <label className="check-row" style={{ marginTop: 8 }}>
                        <input
                          type="checkbox"
                          checked={briefing.proactive}
                          onChange={(e) =>
                            setBriefing((prev) => ({ ...prev, proactive: e.target.checked }))
                          }
                        />
                        <span>
                          <span className="check-row-title">Send it to me on WhatsApp</span>
                          <span className="check-row-desc">
                            Delivered each morning, with a heads-up if you're nearing a travel day
                            limit.
                          </span>
                        </span>
                      </label>
                      {briefing.proactive && (
                        <div className="row" style={{ marginLeft: 28, marginBottom: 10 }}>
                          <span className="muted">at</span>
                          <input
                            type="time"
                            value={briefing.sendTime}
                            onChange={(e) =>
                              setBriefing((prev) => ({ ...prev, sendTime: e.target.value }))
                            }
                            style={{ maxWidth: 130 }}
                          />
                        </div>
                      )}
                    </>
                  )}

                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="btn-primary" onClick={handleSaveBriefing}>
                      Save changes
                    </button>
                    {briefingSaved && <span className="saved-note">Saved</span>}
                  </div>
                </div>
              </>
            )}

            {section === "messaging" && (
              <>
                <h2>WhatsApp</h2>
                <p className="settings-section-intro">
                  Message your assistant from your phone — send it a question, or forward it a
                  boarding pass, receipt, or ticket to file away.
                </p>
                <div className="card card-padded" style={{ marginBottom: 20 }}>
                  {whatsAppStatus.configured && whatsAppStatus.signatureConfigured ? (
                    <div className="banner-note">WhatsApp is connected and ready.</div>
                  ) : (
                    <div className="banner-note">
                      WhatsApp isn't available on your hub yet. You can still use everything here
                      from the web.
                    </div>
                  )}

                  <div className="settings-field" style={{ marginTop: 16 }}>
                    <span className="settings-field-label">Your WhatsApp number</span>
                    <span className="settings-field-hint">
                      One number per account — it's both what can message Marlowe and what
                      receives every proactive alert, so only add a number you want getting that.
                      Include the country code, no spaces or plus sign — for example
                      447911123456. Remove the current one before setting a new one.
                    </span>
                  </div>
                  {allowedNumbers.length === 0 && (
                    <form className="row" onSubmit={handleAddNumber}>
                      <input
                        value={newNumber}
                        onChange={(e) => setNewNumber(e.target.value)}
                        placeholder="447911123456"
                      />
                      <button className="btn-primary" type="submit">
                        <IconPlus />
                        Add
                      </button>
                    </form>
                  )}
                  {numbersSaved && (
                    <span className="saved-note" style={{ display: "block", marginTop: 8 }}>
                      Saved
                    </span>
                  )}
                  {allowedNumbers.length === 0 ? (
                    <p className="muted" style={{ marginTop: 12 }}>
                      No number set yet.
                    </p>
                  ) : (
                    // Normally exactly one row — an account could still show more than one here
                    // only if it predates this one-number limit; removing extras is how to clean
                    // that up, since the add form above stays hidden until the list is empty.
                    allowedNumbers.map((n) => (
                      <div key={n} className="data-row row" style={{ justifyContent: "space-between" }}>
                        <span style={{ fontSize: 13.5 }}>{n}</span>
                        <button className="btn-danger" onClick={() => handleRemoveNumber(n)}>
                          <IconTrash />
                          Remove
                        </button>
                      </div>
                    ))
                  )}
                </div>

                <h2>Instant alerts</h2>
                <div className="card card-padded" style={{ marginBottom: 20 }}>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={alertSettings.enabled}
                      onChange={(e) => handleToggleAlerts(e.target.checked)}
                    />
                    <span>
                      <span className="check-row-title">Ping me when a real person emails</span>
                      <span className="check-row-desc">
                        Newsletters and automated notifications are ignored. Starts from the moment
                        you switch it on, so your existing unread mail won't set it off.
                      </span>
                    </span>
                  </label>
                  {alertSaved && <span className="saved-note">Saved</span>}
                </div>

                <div className="card card-padded" style={{ marginBottom: 20 }}>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={importantEmailSettings.enabled}
                      onChange={(e) => handleToggleImportantEmailAlerts(e.target.checked)}
                    />
                    <span>
                      <span className="check-row-title">Flag important automated mail</span>
                      <span className="check-row-desc">
                        Flight changes, invoices, government mail, deliveries, security alerts,
                        subscription renewals, and refund updates — even from automated senders.
                        On by default; starts from the moment this ships, so your existing unread
                        mail won't set it off.
                      </span>
                    </span>
                  </label>
                  {importantEmailSaved && <span className="saved-note">Saved</span>}
                </div>
              </>
            )}

            {section === "tools" && (
              <>
                <h2>Your tools</h2>
                <p className="settings-section-intro">
                  Switch on only what you need. Each one adds its own section to your sidebar and
                  gives your assistant something extra it can do.
                </p>
                <div className="card card-padded" style={{ marginBottom: 20 }}>
                  {tools.map((t) => (
                    <label key={t.key} className="check-row">
                      <input
                        type="checkbox"
                        checked={t.enabled}
                        onChange={(e) => handleToggleTool(t.key, e.target.checked)}
                      />
                      <span>
                        <span className="check-row-title">{t.label}</span>
                        <span className="check-row-desc">{t.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}

            {section === "files" && (
              <>
                <h2>Folders on this computer</h2>
                <p className="settings-section-intro">
                  Add a folder and your assistant can find files in it by name, alongside anything
                  in your connected cloud accounts.
                </p>
                <div className="card card-padded" style={{ marginBottom: 20 }}>
                  <form className="row" onSubmit={handleAddFolder}>
                    <input
                      value={newFolder}
                      onChange={(e) => setNewFolder(e.target.value)}
                      placeholder="C:\Users\you\Documents"
                    />
                    <button className="btn-primary" type="submit">
                      <IconPlus />
                      Add
                    </button>
                  </form>
                  {folderError && (
                    <p className="error" style={{ marginTop: 8 }}>
                      {folderError}
                    </p>
                  )}
                  {folders.length === 0 ? (
                    <p className="muted" style={{ marginTop: 12 }}>
                      No folders added yet.
                    </p>
                  ) : (
                    folders.map((f) => (
                      <div key={f.id} className="data-row row" style={{ justifyContent: "space-between" }}>
                        <span style={{ fontSize: 13.5 }}>{f.path}</span>
                        <button
                          className="btn-danger"
                          onClick={async () => {
                            await removeLocalFolder(f.id);
                            load();
                          }}
                        >
                          <IconTrash />
                          Remove
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}

            {section === "admin" && user?.isAdmin && (
              <>
                <h2>Waitlist</h2>
                <p className="settings-section-intro">
                  Numbers that messaged Marlowe without an invite. They've been told they're on
                  the waitlist and that we'll message them when they're in — approving one here
                  does exactly that automatically.
                </p>
                <div className="card card-padded" style={{ marginBottom: 20 }}>
                  {!waitlistLoaded ? (
                    <p className="muted">Loading…</p>
                  ) : waitlist.length === 0 ? (
                    <p className="muted">No requests yet.</p>
                  ) : (
                    waitlist.map((req) => (
                      <div
                        key={req.phone}
                        className="data-row row"
                        style={{ justifyContent: "space-between" }}
                      >
                        <div>
                          <span style={{ fontSize: 13.5 }}>{req.phone}</span>{" "}
                          <span className="muted" style={{ fontSize: 12 }}>
                            asked{" "}
                            {new Date(req.firstRequestedAt).toLocaleDateString(undefined, {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            })}
                            {req.requestCount > 1 && ` · ${req.requestCount} messages`}
                          </span>
                        </div>
                        <div className="row" style={{ gap: 8 }}>
                          <button
                            className="btn-primary"
                            onClick={() => handleApproveWaitlist(req.phone)}
                          >
                            <IconPlus />
                            Approve
                          </button>
                          <button
                            className="btn-danger"
                            onClick={() => handleDismissWaitlist(req.phone)}
                          >
                            <IconTrash />
                            Dismiss
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <h2>Invited testers</h2>
                <p className="settings-section-intro">
                  Only numbers on this list can message Marlowe and sign up. Add a number, then
                  send that person the WhatsApp number to message — no need to know their email in
                  advance. Use the full international number with its country code and no leading
                  0 (e.g. 447911123456), since that's the form WhatsApp delivers.
                </p>
                <div className="card card-padded" style={{ marginBottom: 20 }}>
                  <form className="row" onSubmit={handleAddInvite}>
                    <input
                      value={newInvite}
                      onChange={(e) => setNewInvite(e.target.value)}
                      placeholder="447911123456"
                    />
                    <button className="btn-primary" type="submit">
                      <IconPlus />
                      Invite
                    </button>
                  </form>
                  {inviteError && (
                    <p className="error" style={{ marginTop: 8 }}>
                      {inviteError}
                    </p>
                  )}
                  {!invitesLoaded ? (
                    <p className="muted" style={{ marginTop: 12 }}>
                      Loading…
                    </p>
                  ) : invites.length === 0 ? (
                    <p className="muted" style={{ marginTop: 12 }}>
                      Nobody invited yet.
                    </p>
                  ) : (
                    invites.map((inv) => (
                      <div key={inv.phone} className="data-row row" style={{ justifyContent: "space-between" }}>
                        <div>
                          <span style={{ fontSize: 13.5 }}>{inv.phone}</span>{" "}
                          <span className="muted" style={{ fontSize: 12 }}>
                            invited {new Date(inv.invitedAt).toLocaleDateString(undefined, {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            })}
                          </span>
                        </div>
                        <button className="btn-danger" onClick={() => handleRemoveInvite(inv.phone)}>
                          <IconTrash />
                          Remove
                        </button>
                      </div>
                    ))
                  )}
                </div>

                <h2>Reset a test account</h2>
                <p className="settings-section-intro">
                  For testing the WhatsApp sign-up flow repeatedly with the same number. This
                  permanently deletes everything for whatever account is connected to that phone
                  (mail accounts, documents, settings) so it can sign up again from scratch.
                </p>
                <div className="card card-padded">
                  <form className="row" onSubmit={handleResetTestPhone}>
                    <input
                      value={resetPhone}
                      onChange={(e) => setResetPhone(e.target.value)}
                      placeholder="447911123456"
                    />
                    <button className="btn-danger" type="submit" disabled={resetting || !resetPhone.trim()}>
                      <IconTrash />
                      Reset
                    </button>
                  </form>
                  {resetMessage && (
                    <p className="muted" style={{ marginTop: 8 }}>
                      {resetMessage}
                    </p>
                  )}
                </div>

                <h2>Replay onboarding on your own account</h2>
                <p className="settings-section-intro">
                  For re-testing the WhatsApp onboarding UX on your own real account without
                  losing anything — unlike the reset above, this keeps your usage, to-dos, poster
                  board, documents, and memory exactly as they are. It only disconnects your mail
                  account and unbinds your phone number(s), so the next message you send Marlowe
                  starts onboarding fresh and reconnects this same account once you finish OAuth.
                </p>
                <div className="card card-padded">
                  <button className="btn-secondary" onClick={handleReplayOnboarding} disabled={replaying}>
                    <IconRefresh />
                    Replay onboarding
                  </button>
                  {replayMessage && (
                    <p className="muted" style={{ marginTop: 8 }}>
                      {replayMessage}
                    </p>
                  )}
                </div>

                <h2>Watch a test conversation</h2>
                <p className="settings-section-intro">
                  See exactly what a test user's WhatsApp conversation with Marlowe looked like —
                  including where onboarding stalled, if it did.
                </p>
                <div className="card card-padded">
                  <form className="row" onSubmit={handleLoadConversation}>
                    <input
                      value={viewerPhone}
                      onChange={(e) => setViewerPhone(e.target.value)}
                      placeholder="447911123456"
                    />
                    <button className="btn-secondary" type="submit" disabled={viewerLoading || !viewerPhone.trim()}>
                      Load conversation
                    </button>
                  </form>
                  {viewerError && (
                    <p className="error" style={{ marginTop: 8 }}>
                      {viewerError}
                    </p>
                  )}
                  {viewerTimeline && (
                    <div style={{ marginTop: 16 }}>
                      {viewerTimeline.length === 0 ? (
                        <p className="muted">No messages yet for that number.</p>
                      ) : (
                        viewerTimeline.map((entry, i) =>
                          entry.kind === "step" ? (
                            <p
                              key={i}
                              className="muted"
                              style={{ textAlign: "center", fontSize: 12, margin: "8px 0" }}
                            >
                              — {entry.event} {entry.step} —
                            </p>
                          ) : (
                            <div key={i} className={`chat-bubble ${entry.role}`}>
                              {entry.content}
                            </div>
                          )
                        )
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
