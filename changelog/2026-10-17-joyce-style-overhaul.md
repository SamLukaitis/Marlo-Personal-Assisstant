Joyce now talks in short separate messages, uses no emoji, offers "Start new" and "Join existing" as buttons, and sends the family ID on its own so it can be copied.

What changed, all in `server/src/joyce/`:

- **Introduction.** First contact is now four short messages instead of one paragraph: who she
  is, what she does, the wifi-password example of how sharing works, then "Would you like to
  start a new family group, or join an existing one?" with two tappable buttons. A tap arrives as
  the button's title, which the existing new/join word matching already accepts. If the answer
  isn't clear, the question comes back with the buttons again.
- **Family ID on its own.** When a family is created, and when someone asks Joyce for a new ID,
  the ID goes out as a message containing nothing else, so it can be long-pressed and copied
  into a message to someone else.
- **No emoji.** Removed from her scripted messages (introduction, welcome, leave warning) and
  her instructions now say never to use them.
- **Long replies split like Marlowe's.** A reply with several paragraphs goes out as several
  messages with a short pause between them. The splitting code is a copy of Marlowe's
  `services/messageSplitting.ts` in `joyce/messageSplitting.ts`, because Joyce isn't allowed to
  import Marlowe's code. Change both if you change one.
- **Joyce remembers her scripted messages.** The welcome (with the family ID) and the "Lovely to
  meet you" reply after someone gives their name were sent but never saved to the family's
  conversation history, so Joyce couldn't see later what she'd told them. They're saved now.

Replies are now a list of messages (`JoyceMessage[]` in `joyce/messages.ts`) rather than one
string; `sendJoyceReply` in `joyce/routes.ts` sends them in order.
