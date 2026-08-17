import { NEWS_TOPIC_LABELS, type BriefingSettings, type NewsTopic } from "../api/client";

const ALL_TOPICS = Object.keys(NEWS_TOPIC_LABELS) as NewsTopic[];

interface Props {
  value: BriefingSettings;
  onChange: (next: BriefingSettings) => void;
}

// Shared by the signup flow and Settings so the two can't drift — the question "what should your
// briefing show" gets asked once at signup and stays editable in exactly the same shape after.
export function BriefingSourcePicker({ value, onChange }: Props) {
  function patch(next: Partial<BriefingSettings>) {
    onChange({ ...value, ...next });
  }

  function toggleTopic(topic: NewsTopic) {
    patch({
      topics: value.topics.includes(topic)
        ? value.topics.filter((t) => t !== topic)
        : [...value.topics, topic],
    });
  }

  return (
    <div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={value.includeWeather}
          onChange={(e) => patch({ includeWeather: e.target.checked })}
        />
        <span>
          <span className="check-row-title">Weather</span>
          <span className="check-row-desc">Today's conditions and high/low where you are.</span>
        </span>
      </label>
      {value.includeWeather && (
        <div style={{ marginLeft: 28, marginBottom: 12 }}>
          <input
            value={value.weatherLocation}
            onChange={(e) => patch({ weatherLocation: e.target.value })}
            placeholder="Which town or city?"
            style={{ maxWidth: 280 }}
          />
        </div>
      )}

      <label className="check-row">
        <input
          type="checkbox"
          checked={value.includeNews}
          onChange={(e) => patch({ includeNews: e.target.checked })}
        />
        <span>
          <span className="check-row-title">News headlines</span>
          <span className="check-row-desc">Pick the subjects you actually want to hear about.</span>
        </span>
      </label>
      {value.includeNews && (
        <div className="check-grid" style={{ marginLeft: 28, marginBottom: 12 }}>
          {ALL_TOPICS.map((topic) => (
            <label key={topic} className="check-row" style={{ padding: "5px 0" }}>
              <input
                type="checkbox"
                checked={value.topics.includes(topic)}
                onChange={() => toggleTopic(topic)}
              />
              <span>{NEWS_TOPIC_LABELS[topic]}</span>
            </label>
          ))}
        </div>
      )}

      <label className="check-row">
        <input
          type="checkbox"
          checked={value.includeMarkets}
          onChange={(e) => patch({ includeMarkets: e.target.checked })}
        />
        <span>
          <span className="check-row-title">Markets</span>
          <span className="check-row-desc">
            Where the major indices closed, or a watchlist of your own.
          </span>
        </span>
      </label>
      {value.includeMarkets && (
        <div style={{ marginLeft: 28, marginBottom: 12 }}>
          <input
            value={value.tickers.join(", ")}
            // Split on save rather than per-keystroke so typing a comma doesn't fight the field.
            onChange={(e) =>
              patch({
                tickers: e.target.value
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
              })
            }
            placeholder="AAPL, MSFT, ^FTSE"
            style={{ maxWidth: 280 }}
          />
          <p className="settings-field-hint" style={{ marginTop: 6 }}>
            Leave this empty for the S&amp;P 500, Nasdaq, and FTSE 100.
          </p>
        </div>
      )}
    </div>
  );
}
