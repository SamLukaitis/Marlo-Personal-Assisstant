import { useEffect, useState } from "react";
import { saveSettings, type Settings } from "../api/client";
import { IconClose } from "./icons";

interface Props {
  initial: Settings;
  onClose: () => void;
  onSaved: (settings: Settings) => void;
}

// Naming your assistant and telling it how to behave belongs next to the assistant, not buried
// in a settings page — it's the one setting you change while looking at the thing it changes.
export function AssistantConfigModal({ initial, onClose, onSaved }: Props) {
  const [name, setName] = useState(initial.assistantName);
  const [persona, setPersona] = useState(initial.persona);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give your assistant a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = { assistantName: trimmed, persona };
      await saveSettings(next);
      onSaved(next);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Configure your assistant"
    >
      {/* Stop clicks inside the panel from reaching the backdrop's close handler. */}
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Configure your assistant</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div className="settings-field">
          <label className="settings-field-label" htmlFor="assistant-name">
            What should it be called?
          </label>
          <input
            id="assistant-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ maxWidth: 300 }}
          />
        </div>

        <div className="settings-field">
          <label className="settings-field-label" htmlFor="assistant-persona">
            How should it work with you?
          </label>
          <span className="settings-field-hint">
            Its tone, what to prioritise, and anything it should know about you and your work.
          </span>
          <textarea
            id="assistant-persona"
            rows={6}
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            placeholder="e.g. I run three businesses. Be brief and direct. When I ask about invoices, check the Acme account first, and flag anything from my accountant as urgent."
          />
        </div>

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
