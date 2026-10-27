// The conversation the page plays out as you scroll. Marlo's lines stay short and professional.
export type Message = { from: "you" | "marlo"; text: string; time: string };
export type Scene = {
  id: "email" | "documents" | "trips";
  title: string;
  heading: string;
  caption: string;
  messages: Message[];
};

export const scenes: Scene[] = [
  {
    id: "email",
    title: "Inbox",
    heading: "Your inbox, sorted",
    caption: "Marlo reads, files and answers your email, and only brings you what needs a decision.",
    messages: [
      { from: "you", time: "7:42", text: "Can you go through my inbox?" },
      {
        from: "marlo",
        time: "7:42",
        text: "Done. 31 new: 14 filed, 12 newsletters cleared, 5 need you. Two are time-sensitive: the Hartley invoice and Priya's question about Thursday.",
      },
      { from: "you", time: "7:44", text: "What does Priya want?" },
      {
        from: "marlo",
        time: "7:44",
        text: "To move Thursday's call to 3pm. You're free then. Draft reply: \"3pm works. I'll send the link.\" Want me to send it?",
      },
      { from: "you", time: "7:45", text: "Yes." },
      {
        from: "marlo",
        time: "7:45",
        text: "Done. I've moved it to 3pm on your calendar. The Hartley invoice is due Friday, so I'll remind you Thursday evening.",
      },
    ],
  },
  {
    id: "documents",
    title: "Documents",
    heading: "Send it a photo, find it later",
    caption: "Photograph a receipt, a letter or a PDF. Marlo reads it, keeps it, and finds it again when you ask.",
    messages: [
      { from: "you", time: "12:10", text: "[photo of a receipt]" },
      {
        from: "marlo",
        time: "12:10",
        text: "Got it. £48.60 at Corrigan's Garage, 14 October, for the MOT. Saved.",
      },
      { from: "you", time: "09:05", text: "What did the MOT cost last month?" },
      {
        from: "marlo",
        time: "09:05",
        text: "£48.60, at Corrigan's Garage on 14 October. Want the receipt back?",
      },
      { from: "you", time: "09:06", text: "Yes please." },
      { from: "marlo", time: "09:06", text: "Here it is." },
    ],
  },
  {
    id: "trips",
    title: "Trips",
    heading: "It knows what's coming up",
    caption: "Marlo spots flights, hotels and bookings in your email, and reminds you at the right moment.",
    messages: [
      { from: "you", time: "18:30", text: "What have I got booked in November?" },
      {
        from: "marlo",
        time: "18:30",
        text: "Porto, Thu 12 to Sun 15 Nov. TAP out at 10:15, back at 20:50. Hotel Ribeira, three nights, free cancellation until 9 Nov.",
      },
      { from: "you", time: "18:31", text: "Remind me about the flight." },
      {
        from: "marlo",
        time: "18:31",
        text: "I'll message you the evening before with the times and your booking reference.",
      },
      { from: "you", time: "18:32", text: "Thanks." },
      { from: "marlo", time: "18:32", text: "Anytime." },
    ],
  },
];
