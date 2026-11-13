# Understand WhatsApp voice notes

Users send voice notes and ask Marlo to transcribe or act on them (unmet request, 11 Nov 2026).
Today anything that isn't text, a photo, a document or a location gets a fixed "I can't read that
yet" reply (`routes/whatsappRoutes.ts`). The Portal's Feature use tab counts how often this
happens, which says how much demand there is.

## What's needed

- Download the audio from Meta (the media download code for photos already does this).
- Transcribe it. Claude doesn't take audio, so this needs a speech-to-text service, which is a new
  provider, a new key and a new cost per minute. Pick one and check where it processes audio before
  sending users' voice to it.
- Treat the transcript as if the user had typed it, and keep a line in chat history saying it was
  a voice note, so Marlo can say "in your voice note you said…".

## Things to watch

- Length: cap what gets transcribed (a few minutes) and say so when a note is longer.
- A transcript can be wrong. For anything with a consequence (sending an email, a reminder time),
  Marlo should repeat back what it understood before acting.
- Forwarded voice notes from other people are someone else's words, not the user's instructions.
