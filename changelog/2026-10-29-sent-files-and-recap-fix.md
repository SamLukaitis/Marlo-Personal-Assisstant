Marlo no longer thinks it failed to send files it did send, and the evening recap and morning briefing stop coming out blank or as the plain backup list.

## Marlo doubting files it had sent

When you asked Marlo for a saved photo (a passport, a driving licence), it sent the file, but the
chat history only kept the words of its reply ("Here's your passport"). There was no record that a
file had gone. On the next message Marlo read back "I've sent it", saw no sign of a file, decided it
had claimed something it hadn't done, apologised, and sent the file again. This started showing up
after the move to the Claude 5.5 models on 19 Oct, which are more careful about not claiming things
they can't back up.

Now, when a reply sends files, chat history keeps a line under it such as
`[Files sent with this message: Passport, Driving licence]`. You never see this line on WhatsApp.
Marlo's instructions say that line is the record the files went, and that it shouldn't apologise or
resend unless you say one didn't arrive.

## Evening recap (and morning briefing) coming out empty

Since 19 Oct the recap and briefing have been written by Claude Sonnet 5.5, which thinks before it
writes. That thinking counts against the length cap, and the cap was small (512 tokens for the
recap, 1024 for the briefing). Some evenings Marlo used the whole cap thinking and wrote nothing.
The recap then fell back to the plain list of senders, which looked messy. The server logged
"the model returned no text for the digest" on 26, 27 and 28 Oct. In the same situation the
briefing would have sent "Nothing to report today."

Both now have a cap of 4096 tokens and ask for low effort. A few short paragraphs from a list of
facts doesn't need deep thinking. The higher cap gives room to write; it doesn't make the messages
longer.
