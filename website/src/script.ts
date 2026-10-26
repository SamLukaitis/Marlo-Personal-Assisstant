// The conversation the page plays out as you scroll. Marlo's lines stay short and professional.
export type Message = { from: "you" | "marlo"; text: string; time: string };
export type Scene = { id: "email" | "travel" | "itinerary"; messages: Message[] };

export const scenes: Scene[] = [
  {
    id: "email",
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
        text: "To move Thursday's call to 3pm. You're free then. Draft reply: \"3pm works. I'll send the link.\" Send it?",
      },
      { from: "you", time: "7:45", text: "Yes." },
      {
        from: "marlo",
        time: "7:45",
        text: "Sent, and the invite is moved to 3pm. The Hartley invoice is due Friday. I've flagged it for you.",
      },
    ],
  },
  {
    id: "travel",
    messages: [
      { from: "you", time: "12:10", text: "Lisbon or Porto for 4 days in November?" },
      {
        from: "marlo",
        time: "12:10",
        text: "Porto. Hotels average £94 a night against £131 in Lisbon, the city is walkable, and it's drier that week. Lisbon wins only if you want the beaches.",
      },
      { from: "you", time: "12:12", text: "Show me flights." },
      {
        from: "marlo",
        time: "12:12",
        text: "Three options from London, 12-15 Nov. Cheapest: £68 return, Ryanair, 06:40 out. Best: £112, TAP, 10:15 out, 20:50 back. I'd take the TAP flight.",
      },
      { from: "you", time: "12:14", text: "Book the TAP one." },
      {
        from: "marlo",
        time: "12:14",
        text: "I can't pay for you. Here's the booking link with your details filled in. It's held for 20 minutes.",
      },
    ],
  },
  {
    id: "itinerary",
    messages: [
      { from: "you", time: "18:30", text: "Put together the Porto itinerary." },
      {
        from: "marlo",
        time: "18:30",
        text: "Thu 12: land 12:05, check in at the Ribeira hotel, dinner at 20:00. Fri 13: Livraria Lello at 09:30, Douro river cruise at 14:00. Sat 14: Foz do Douro, port tasting at 17:00. Sun 15: flight 20:50.",
      },
      { from: "you", time: "18:32", text: "Send it to Dan." },
      {
        from: "marlo",
        time: "18:32",
        text: "Sent to Dan with the flight times and hotel address. I've added all four days to your calendar.",
      },
      { from: "you", time: "18:33", text: "Thanks." },
      { from: "marlo", time: "18:33", text: "Anytime. I'll check you in the day before you fly." },
    ],
  },
];
