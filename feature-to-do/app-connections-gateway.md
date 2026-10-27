# Connect more apps without overloading Marlo

**What's wanted:** let users connect apps like Notion, Todoist and Slack so Marlo can read and act
in them, without each new app adding more tools for Marlo to choose between.

**Why:** Marlo already juggles about 60 tools, and more tools makes it worse at choosing the right
one and more expensive per message. The plan is a connection service (Composio) behind just two
tools, "find an action" and "run an action". Marlo searches the actions available in the apps that
user has connected, and only when it needs them. When a user asks for an app they haven't connected,
Marlo sends a one-tap connect link at that moment, not during sign-up.

**Not for:** Uber, OpenTable, Resy and Spotify. They don't let outside apps act for their users, so
they're covered by hand-off links instead (`changelog/2026-10-12-app-handoff-links.md`).

**Later still:** if many users ask Marlo to actually *finish* bookings (see the Portal's Unmet
Requests tab), look at browser automation (Stagehand + Browserbase, `docs/integration-ideas.md` #8).
