import type { MouseEvent } from "react";
import { Link } from "react-router-dom";
import type { Tool } from "../api/client";
import { useTools } from "../context/ToolsContext";
import { prefersReducedMotion } from "../lib/motionPrefs";
import "./features.css";

// One place to see everything Marlowe can do (feature-to-do/marlowe-capabilities-ui.md) — until
// this existed, a capability was only discoverable by asking in chat or already knowing about it.
// The copy is hand-written for users rather than generated from the assistant's tool list: tool
// descriptions are written for the model, and several features (alerts, trip nudges, the digest)
// aren't tools at all. When a feature ships, add it here.

interface Topic {
  id: string;
  title: string;
  body: string;
  /** Things to say to Marlowe, word for word. */
  examples?: string[];
  /** Only works on WhatsApp (photos, reminders, location pins). */
  whatsappOnly?: boolean;
  /** An optional tool the user has to switch on first — shown as on/off with a link to Settings. */
  requiresTool?: Tool["key"];
}

interface Chapter {
  id: string;
  title: string;
  intro: string;
  topics: Topic[];
}

const CHAPTERS: Chapter[] = [
  {
    id: "getting-started",
    title: "Getting started",
    intro: "How to reach Marlowe, and what it needs from you to be useful.",
    topics: [
      {
        id: "talking-to-marlowe",
        title: "Talking to Marlowe",
        body: "Message Marlowe on WhatsApp or use the Assistant page here. It's the same assistant in both places, so ask in plain language, the way you'd ask a person.",
        examples: ["What's on today?", "Did anyone important email me this morning?"],
      },
      {
        id: "connecting-accounts",
        title: "Connecting your accounts",
        body: "Marlowe works with Gmail and Outlook mail, calendars, contacts and files (Google Drive and OneDrive). You can connect several accounts, personal and work, and Marlowe looks across all of them at once.",
        examples: ["Connect my Outlook"],
      },
      {
        id: "quick-replies",
        title: "Tap-to-answer questions",
        body: "When Marlowe needs a yes or no, or a choice between a few options, it shows buttons you can tap instead of making you type. Anything it can't take back, like sending an email, always waits for you to tap to confirm.",
      },
      {
        id: "when-it-cant",
        title: "When Marlowe can't help",
        body: "If you ask for something Marlowe can't do yet, it tells you so and doesn't guess. It also passes the request on to the team, so the things people ask for most get built next.",
      },
    ],
  },
  {
    id: "communication",
    title: "Communication",
    intro: "Reading, writing and tidying email, plus your contacts and Teams chats.",
    topics: [
      {
        id: "reading-email",
        title: "Finding and reading email",
        body: "Ask about recent mail or search for something specific: a sender, a subject, an attachment, a date range. Marlowe can open an email and summarise it, and it remembers emails you've already looked at, even after you've archived them.",
        examples: [
          "What's new in my inbox?",
          "Find the email from the accountant about the tax return",
          "Summarise the latest from Sarah",
        ],
      },
      {
        id: "writing-email",
        title: "Writing and sending email",
        body: "Marlowe drafts emails and replies from your own Gmail or Outlook account. It shows you the email first and sends nothing until you tap Send. If you'd rather finish it yourself, it can save it to your Drafts instead.",
        examples: ["Reply to Tom and say Thursday works", "Draft an email to the landlord about the boiler and leave it in drafts"],
      },
      {
        id: "needs-reply",
        title: "What needs a reply",
        body: "Marlowe can pick out emails from real people that have been sitting unread for a while, leaving out newsletters, receipts and automatic confirmations.",
        examples: ["Is there anything I haven't replied to?"],
      },
      {
        id: "tidying-inbox",
        title: "Tidying your inbox",
        body: "Archive mail in bulk, add labels (Gmail) or categories (Outlook), and unsubscribe from marketing lists. Archiving never deletes anything, so you can always get it back. Unsubscribing can't be undone, so Marlowe asks before doing it.",
        examples: ["Archive everything from Nike", "Label the invoice from Acme as Accounts", "Unsubscribe me from these promotions"],
      },
      {
        id: "email-alerts",
        title: "Email alerts and the daily digest",
        body: "Marlowe watches your inbox in the background. Important automatic mail, like flight changes, reservations, deliveries, invoices due, security alerts and renewals, gets an instant WhatsApp message. Emails from real people are collected into one daily digest at a time you choose, or you can have a message for each one as it arrives.",
        examples: ["Message me straight away when someone emails me", "Turn off the important-email alerts"],
        whatsappOnly: true,
      },
      {
        id: "contacts",
        title: "Contacts",
        body: "Give a name and Marlowe looks up the email address in your connected accounts, so you don't need the address when you ask it to write to someone.",
        examples: ["What's Sarah Collins' email address?"],
      },
      {
        id: "teams",
        title: "Microsoft Teams chats",
        body: "Look through and search your recent Teams direct messages and group chats. Your chats also appear on the Chats page.",
        examples: ["What did James say in Teams about the launch?"],
        requiresTool: "teams",
      },
    ],
  },
  {
    id: "scheduling",
    title: "Scheduling",
    intro: "Your calendar, finding time, and reminders.",
    topics: [
      {
        id: "your-calendar",
        title: "Seeing your schedule",
        body: "Ask what's coming up across every connected calendar, or open the Calendar page to see it laid out.",
        examples: ["What does next week look like?", "When's my dentist appointment?"],
      },
      {
        id: "managing-events",
        title: "Adding, moving and cancelling events",
        body: "Marlowe can put events on your calendar, move them and cancel them. It only ever touches your own calendar and never sends invitations to other people. Events abroad are added in local time, so a 9am meeting in New York shows up at the right time wherever you are.",
        examples: ["Put lunch with Ana on Friday at 1pm", "Move my 3pm call to tomorrow", "Cancel the gym on Saturday"],
      },
      {
        id: "free-time",
        title: "Finding free time",
        body: "Marlowe looks for gaps in your calendar during working hours. It works these out from your actual calendar, so they're never guessed.",
        examples: ["Find me an hour this week", "When am I free tomorrow afternoon?"],
      },
      {
        id: "reminders",
        title: "Reminders",
        body: "Set a one-off reminder for a time or a set number of minutes from now, or a run of nudges inside a time window. Marlowe can show you what's scheduled, cancel a reminder, and tell you whether one went out.",
        examples: ["Remind me at 3pm to call the bank", "Remind me in 20 minutes to take the bread out", "What reminders do I have?"],
        whatsappOnly: true,
      },
    ],
  },
  {
    id: "briefings",
    title: "Briefings and the news",
    intro: "What Marlowe tells you without being asked, and the outside world on demand.",
    topics: [
      {
        id: "morning-briefing",
        title: "Morning briefing",
        body: "A short message each morning covering who's been in touch, what's on your calendar, and anything coming up. You choose the send time and can add news, weather and markets.",
        examples: ["Send my briefing at 7am", "Add tech news and the weather in London to my briefing"],
        whatsappOnly: true,
      },
      {
        id: "news",
        title: "News",
        body: "Headlines on topics like world, business and tech, whenever you ask. This works even if news isn't part of your briefing.",
        examples: ["Any tech news today?"],
      },
      {
        id: "weather",
        title: "Weather",
        body: "Today's weather, high and low for anywhere in the world, not only your home city.",
        examples: ["What's the weather in Lisbon?"],
      },
      {
        id: "markets",
        title: "Markets",
        body: "Current prices and today's move for shares and the major indices.",
        examples: ["How's the FTSE doing?", "What's Apple trading at?"],
      },
      {
        id: "web-search",
        title: "Searching the web",
        body: "For anything that isn't in your accounts, Marlowe can search the web and tell you where the answer came from.",
        examples: ["What time does the Tate Modern close on Sundays?"],
      },
    ],
  },
  {
    id: "travel",
    title: "Travel",
    intro: "Bookings, trips, getting around, and counting days abroad.",
    topics: [
      {
        id: "bookings",
        title: "Flights and hotels",
        body: "Send Marlowe a confirmation (a screenshot, a PDF, or the email it came in) and it saves the booking: dates, reference number, flight or hotel name. Ask about it later without digging through your inbox.",
        examples: ["When is my flight to Berlin?", "What's the reference for the hotel in Rome?"],
      },
      {
        id: "travel-prices",
        title: "Flight and hotel prices",
        body: "Marlowe searches live flight and hotel prices for your dates. It compares airlines, times and stops, or hotels by price, stars, rating and free cancellation, and sends links so you can book. It never books anything itself.",
        examples: ["Flights from London to Barcelona on 20 November", "Find me a hotel in Lisbon 12 to 15 November under £150 a night"],
      },
      {
        id: "trip-nudges",
        title: "Before you go",
        body: "The day before a saved flight, Marlowe sends a message around when online check-in usually opens. On the morning of a hotel check-in, you get a reminder about the hotel too.",
        whatsappOnly: true,
      },
      {
        id: "trips",
        title: "Trips",
        body: "Group everything for one journey into a trip: bookings, expenses, documents and check-ins. Then you can ask about the whole trip at once.",
        examples: ["Start a trip for Lisbon, 12 to 18 May", "That hotel booking was for the Lisbon trip", "What do we have for Lisbon?"],
      },
      {
        id: "places",
        title: "Places nearby",
        body: "Find real restaurants, cafés, pharmacies, shops and sights from Google Maps, with ratings, opening hours and a map link. If you ask for something near you, Marlowe shows a button so you can send your location in one tap.",
        examples: ["Find a good coffee place near me", "Is there a pharmacy open near the hotel?"],
      },
      {
        id: "directions",
        title: "Travel times",
        body: "Driving or walking distance and time between two places. Public transport isn't supported yet.",
        examples: ["How long to walk from here to the station?"],
      },
      {
        id: "schengen",
        title: "Where you've been and Schengen days",
        body: "Marlowe can keep a log of the countries and cities you arrive in, then count the days you've spent in a country, in the EU, or in the Schengen area over the rolling 180 days. The Travel page shows how many of your 90 Schengen days you've used.",
        examples: ["How many Schengen days have I used?", "When did I arrive in France?"],
        requiresTool: "travel",
      },
    ],
  },
  {
    id: "documents",
    title: "Documents and files",
    intro: "Photos and papers you send Marlowe, and the files already in your accounts.",
    topics: [
      {
        id: "sending-documents",
        title: "Saving photos and documents",
        body: "Send a photo, PDF or Word document on WhatsApp, such as a passport, licence, boarding pass, ticket or receipt. Marlowe reads it and saves the details so you can ask about them later.",
        examples: ["What's the number on my driving licence?", "What have I saved recently?"],
        whatsappOnly: true,
      },
      {
        id: "getting-originals",
        title: "Getting the original back",
        body: "Need the actual photo or file again, not just the details? Marlowe sends you the original.",
        examples: ["Send me that photo of my passport again"],
        whatsappOnly: true,
      },
      {
        id: "email-attachments",
        title: "Email attachments",
        body: "Marlowe can open an attachment from an email, like a ticket, an invoice or a booking, and save it alongside the things you've sent it.",
        examples: ["Save the ticket attached to the Eurostar email"],
      },
      {
        id: "matching-email",
        title: "Linking new mail to what you've saved",
        body: "When a new email comes in about something you've already saved, such as a change to a booking, Marlowe lets you know.",
        whatsappOnly: true,
      },
      {
        id: "searching-files",
        title: "Searching your files",
        body: "Find files by name in Google Drive, OneDrive and any folders on your computer you've added. The Files page lets you search them yourself.",
        examples: ["Find the spreadsheet with the 2025 budget"],
      },
    ],
  },
  {
    id: "money",
    title: "Money",
    intro: "Expenses from your receipts, and handing them to your accountant.",
    topics: [
      {
        id: "expenses",
        title: "Expenses from receipts",
        body: "Every receipt or invoice you send gets logged as an expense: who it's from, how much and when. If Marlowe wasn't sure it read something correctly, it marks that expense to be checked. It can remove one that was logged by mistake.",
        examples: ["Find that taxi receipt from last week", "That receipt was logged twice, remove one"],
      },
      {
        id: "spending",
        title: "Spending summaries",
        body: "Totals for any period, where you spend the most, and how that compares with the period before. Expenses Marlowe isn't sure about are left out of the totals and counted separately.",
        examples: ["How much have I spent this month?", "Am I spending more than last month?"],
      },
      {
        id: "xero",
        title: "Forwarding receipts to Xero",
        body: "Give Marlowe your Xero forwarding address and every receipt you send is emailed to Xero for you automatically. If something looks like an invoice, Marlowe asks before forwarding it.",
        examples: ["My Xero forwarding address is receipts@example.xero.com"],
      },
    ],
  },
  {
    id: "memory",
    title: "Memory",
    intro: "What Marlowe remembers about you, and how to change it.",
    topics: [
      {
        id: "remembering",
        title: "Remembering what you tell it",
        body: "Tell Marlowe something worth knowing, like which account is for work, who your accountant is or how you like things done, and it remembers it for next time without being asked.",
        examples: ["My work email is the Outlook one", "Remember that Sarah is my sister"],
      },
      {
        id: "people-and-places",
        title: "People, places and projects",
        body: "Marlowe keeps track of the people, places and projects you mention and how they connect, so you can ask everything it knows about one of them at once.",
        examples: ["What do you know about Sarah?"],
      },
      {
        id: "forgetting",
        title: "Correcting and forgetting",
        body: "If something it remembers is wrong or out of date, tell Marlowe and it'll fix it or forget it completely.",
        examples: ["Forget everything about the old flat", "That's wrong, Tom works at Deloitte now"],
      },
      {
        id: "past-conversations",
        title: "Past conversations",
        body: "Marlowe can look back through your full WhatsApp history with it, so you can refer to something you talked about weeks ago.",
        examples: ["What was that restaurant you recommended last month?"],
      },
    ],
  },
  {
    id: "privacy",
    title: "Privacy and control",
    intro: "What Marlowe will and won't do, and the switches you control.",
    topics: [
      {
        id: "safeguards",
        title: "Built-in safeguards",
        body: "Marlowe never sends an email without your tap, never invites anyone to an event, and never deletes email (archiving can always be undone). Before anything it can't take back, like cancelling an event or unsubscribing, it asks you first.",
      },
      {
        id: "your-data",
        title: "Your data",
        body: "Marlowe is invite-only, and each person's accounts, documents and memories are kept separate. Account connections and the documents you send are encrypted.",
      },
      {
        id: "settings",
        title: "Turning things on and off",
        body: "Settings is where you connect accounts, choose what goes in your briefing, set up alerts, and switch optional tools like Teams and travel tracking on or off. You can also just ask Marlowe to change most of these.",
        examples: ["Turn on the travel tracker", "Take markets out of my briefing"],
      },
    ],
  },
];

const TOOL_LABELS: Record<Tool["key"], string> = {
  teams: "Teams",
  travel: "Travel tracker",
};

// Smooth in-page jumps without putting a #hash on the route, which react-router would otherwise
// treat as navigation history for every contents click.
function jumpTo(e: MouseEvent, id: string) {
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView({
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "start",
  });
}

export function FeaturesPage() {
  const { isEnabled, loaded } = useTools();

  return (
    <div className="main scrollable">
      <div className="main-inner scrollable">
        <div className="page-header" id="contents">
          <h1 className="heading-font">What Marlowe can do</h1>
        </div>
        <p className="muted features-lede">
          Everything Marlowe can help with, grouped by chapter. The examples are things you can
          say to it, word for word.
        </p>

        <nav className="card card-padded features-toc" aria-label="Contents">
          <ol className="features-toc-chapters">
            {CHAPTERS.map((chapter, i) => (
              <li key={chapter.id}>
                <a href={`#${chapter.id}`} onClick={(e) => jumpTo(e, chapter.id)} className="features-toc-chapter">
                  <span className="features-num">{i + 1}</span>
                  {chapter.title}
                </a>
                <ul className="features-toc-topics">
                  {chapter.topics.map((topic) => (
                    <li key={topic.id}>
                      <a href={`#${topic.id}`} onClick={(e) => jumpTo(e, topic.id)}>
                        {topic.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </nav>

        {CHAPTERS.map((chapter, i) => (
          <section key={chapter.id} id={chapter.id} className="features-chapter">
            <div className="features-chapter-head">
              <span className="features-num">{i + 1}</span>
              <div>
                <h2 className="heading-font features-chapter-title">{chapter.title}</h2>
                <p className="muted features-chapter-intro">{chapter.intro}</p>
              </div>
            </div>

            <div className="card features-topics">
              {chapter.topics.map((topic) => {
                const toolOn = topic.requiresTool && loaded && isEnabled(topic.requiresTool);
                return (
                  <article key={topic.id} id={topic.id} className="features-topic">
                    <div className="features-topic-head">
                      <h3>{topic.title}</h3>
                      {topic.whatsappOnly && <span className="features-tag">WhatsApp</span>}
                      {topic.requiresTool && loaded && (
                        <span className={`features-tag${toolOn ? " on" : ""}`}>
                          {TOOL_LABELS[topic.requiresTool]} {toolOn ? "on" : "off"}
                        </span>
                      )}
                    </div>
                    <p>{topic.body}</p>
                    {topic.requiresTool && loaded && !toolOn && (
                      <p className="features-tool-note">
                        This is optional. <Link to="/settings?section=tools">Turn it on in Settings</Link>.
                      </p>
                    )}
                    {topic.examples && (
                      <ul className="features-examples" aria-label="Things to say">
                        {topic.examples.map((ex) => (
                          <li key={ex}>“{ex}”</li>
                        ))}
                      </ul>
                    )}
                  </article>
                );
              })}
            </div>

            <a href="#contents" onClick={(e) => jumpTo(e, "contents")} className="features-back">
              Back to contents
            </a>
          </section>
        ))}
      </div>
    </div>
  );
}
