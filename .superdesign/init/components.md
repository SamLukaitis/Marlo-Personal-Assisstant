# Shared UI Primitives

Framework: React 19 + Vite + TypeScript. No component library — plain CSS (`client/src/index.css`), no Tailwind, no CSS Modules, no styled-components. Styling is done via global class names (`.card`, `.btn`, `.row`, `.muted`, etc.) plus ad-hoc inline `style={{}}` props on individual elements.

There are no dedicated `Button.tsx` / `Card.tsx` / `Input.tsx` component files — "primitives" are just semantic HTML (`<button>`, `<input>`, `<textarea>`, a `<div className="card">`) styled globally in `index.css`. The closest things to reusable components are below.

## Icons — `client/src/components/icons.tsx`
A set of inline SVG icon components, all sharing one stroke style (17x17, `currentColor`, strokeWidth 1.75).

```tsx
import type { SVGProps } from "react";

const base: SVGProps<SVGSVGElement> = {
  width: 17,
  height: 17,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

export const IconChat = () => (
  <svg {...base}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

export const IconInbox = () => (
  <svg {...base}>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </svg>
);

export const IconCalendar = () => (
  <svg {...base}>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
  </svg>
);

export const IconFolder = () => (
  <svg {...base}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z" />
  </svg>
);

export const IconSettings = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.36.14.687.36.951.673.264.313.44.687.514 1.09" />
  </svg>
);

export const IconSend = () => (
  <svg {...base} width={16} height={16}>
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </svg>
);

export const IconUsers = () => (
  <svg {...base}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

export const IconPlus = () => (
  <svg {...base} width={15} height={15}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconSearch = () => (
  <svg {...base}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.35-4.35" />
  </svg>
);

export const IconTrash = () => (
  <svg {...base} width={15} height={15}>
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6" />
  </svg>
);
```

## CSS-based "components" (class names, no React wrapper)

Defined in `client/src/index.css` (see `theme.md` for the full file). Used as `className="card"` etc. throughout every page:

- **`.card`** — white surface, 1px border, `--radius` (8px), `box-shadow: var(--shadow-sm)`, `padding: 16px 18px`. The universal content container.
- **`.banner`** — inline accent-tinted info strip (`background: var(--accent-soft)`, `color: var(--accent)`), used for success/info messages. Reused with `background: var(--danger-soft); color: var(--danger)` inline override for error banners (see `HomePage.tsx`).
- **`.badge`** — small pill label (11px, bordered, muted), used for account-email tags, provider tags, source tags.
- **`.list-item`** — a row in a list, bottom border, no border on `:last-child`; contains `.title` (flex space-between, bold) and `.sub` (muted, smaller). Optional `.title.unread` adds a bold weight + accent dot via `::before`.
- **`.row`** — `display:flex; gap:8px; align-items:center` — the universal horizontal-stack utility, used everywhere instead of a `<Stack>` component.
- **`.muted`** — secondary/quiet text color + smaller size.
- **`.error`** — red error text.
- **`.chips`** — flex-wrap pill button row (used for AssistantPage's suggested-prompt chips).
- **Buttons** — plain `<button>` styled globally: default (solid dark), `.secondary` (outlined), `.danger` (outlined red). No `Button` component/variants prop — variant is just a className string.
- **Inputs** — plain `<input>` / `<textarea>`, globally styled, no wrapper component, no visible label component (labels are bare `<label className="muted">`).

## Notable gap
No `Modal`/`Dialog`, `Toast`, `Tabs`, `Avatar`, `Table`, `Checkbox` (custom-styled — uses raw `<input type="checkbox">`), or `Spinner` component. Loading states are just `<p className="muted">Loading…</p>` text. "Saved ✓" confirmations are inline `<span className="muted">` shown for 2.5s via `setTimeout`. This is a strong signal that a redesign has a lot of room to introduce real primitives (Button variants, Toast/inline-confirm pattern, Modal, Skeleton loaders) without fighting existing abstractions.
