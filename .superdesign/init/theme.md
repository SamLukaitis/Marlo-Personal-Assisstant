# Theme / Design Tokens

## Part 1 — Compact token summary

**No dark mode exists today** — single `:root` palette only, no `.dark`/`[data-theme]` variants, no `prefers-color-scheme` media query anywhere in `index.css`.

### Colors (`:root`)
| Token | Value | Usage |
|---|---|---|
| `--bg` | `#fafafa` | Page background |
| `--surface` | `#ffffff` | Cards, sidebar, inputs |
| `--border` | `#e5e5e8` | Default borders/dividers |
| `--border-strong` | `#d4d4d8` | Input borders, secondary button borders |
| `--text` | `#18181b` | Primary text, primary button background, brand mark |
| `--text-soft` | `#3f3f46` | Labels |
| `--muted` | `#71717a` | Secondary text |
| `--muted-2` | `#a1a1aa` | Placeholder text, disabled state, status dot (off) |
| `--accent` | `#2952e3` | Links, active nav item, focus ring, unread dot |
| `--accent-soft` | `#eef1fd` | Banner bg, active nav bg, focus ring glow, hover states |
| `--danger` | `#b91c1c` | Error text, danger button text |
| `--danger-soft` | `#fef2f2` | Error banner bg |
| `--success` | `#16a34a` | Connected status dot |

Only **one** accent color (`--accent`, a blue) in the whole app — this is the "unbranded" placeholder color the user wants replaced/formalized in the redesign.

### Radius / Shadow
| Token | Value |
|---|---|
| `--radius` | `8px` (cards, chat bubbles, chat scroll area) |
| `--radius-sm` | `6px` (buttons, inputs, nav items, badges) |
| `--shadow-sm` | `0 1px 2px rgba(16,16,20,0.04)` (cards, chat scroll) |
| `--shadow-md` | `0 4px 16px rgba(16,16,20,0.06)` (defined but appears unused currently) |

### Typography
- Font stack: `-apple-system, "Segoe UI", "Inter", system-ui, sans-serif` — no self-hosted/Google font actually loaded (Inter is named but not imported anywhere), so it silently falls back to system UI fonts.
- Base body size: `14.5px`, line-height `1.5`.
- `h1`: `19px / 600 weight / -0.01em letter-spacing`.
- `h2`: `12.5px / 600 weight / uppercase / 0.04em letter-spacing / var(--muted)` — used as small section eyebrows, not real headings.
- Small text scale used throughout: `13.5px` (most labels/buttons/inputs), `12.5px` (`.muted`, badges' parent), `12px`/`11px` (badges, footer).
- No defined type scale beyond these ad-hoc sizes — no `--font-size-*` tokens.

### Spacing / Layout
- No spacing scale tokens — all spacing is hardcoded per-use (`padding: 16px 18px`, `gap: 8px`, `margin: 28px 0 10px`, etc.), inconsistent px values throughout (8, 9, 10, 11, 12, 14, 16, 18, 20...).
- Sidebar width: `216px` fixed.
- Page content: `.main { max-width: 880px; margin: 0 auto; padding: 32px 40px; }`.
- No breakpoints/media queries defined — **the app is not responsive at all today** (fixed sidebar, fixed max-width, no mobile layout).

### Component-specific tokens (not variables, just consistent patterns)
- Chat bubbles: user = solid `--text` bg / white text, right-aligned; assistant = `--bg` bg / bordered, left-aligned. Asymmetric corner radius (`border-bottom-*-radius: 3px`) for a "tail" effect.
- Buttons: primary = solid `--text`; `.secondary` = outlined; `.danger` = outlined red. No filled/accent-colored primary button anywhere — primary actions are visually black/dark, not on-brand-colored.

## Part 2 — Raw source dump

No `tailwind.config.*` (Tailwind is not used). Full `client/src/index.css`:

```css
:root {
  --bg: #fafafa;
  --surface: #ffffff;
  --border: #e5e5e8;
  --border-strong: #d4d4d8;
  --text: #18181b;
  --text-soft: #3f3f46;
  --muted: #71717a;
  --muted-2: #a1a1aa;
  --accent: #2952e3;
  --accent-soft: #eef1fd;
  --danger: #b91c1c;
  --danger-soft: #fef2f2;
  --success: #16a34a;
  --radius: 8px;
  --radius-sm: 6px;
  --shadow-sm: 0 1px 2px rgba(16, 16, 20, 0.04);
  --shadow-md: 0 4px 16px rgba(16, 16, 20, 0.06);
  font-family: -apple-system, "Segoe UI", "Inter", system-ui, sans-serif;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  font-size: 14.5px;
  line-height: 1.5;
}

#root {
  display: flex;
  min-height: 100vh;
}

/* Full remaining rules (sidebar, .main, h1/h2, .card, .muted, .error, .banner, .badge,
   inputs/textarea/buttons, .row, .list-item, .chat-wrap/.chat-scroll/.bubble, .chips)
   are reproduced verbatim in layouts.md / components.md above — omitted here to avoid
   duplication; see those files for the exact rules tied to each component. */
```

(Full duplicate omitted per dedup guidance — every rule in `index.css` is already quoted inline next to the component it styles in `components.md` and `layouts.md`.)
