import Parser from "rss-parser";

const parser = new Parser();

// Free, public RSS feeds — no API key required.
export const NEWS_TOPICS = {
  world: { label: "World", feed: "http://feeds.bbci.co.uk/news/world/rss.xml" },
  technology: { label: "Technology", feed: "http://feeds.bbci.co.uk/news/technology/rss.xml" },
  business: { label: "Business", feed: "http://feeds.bbci.co.uk/news/business/rss.xml" },
  sports: { label: "Sports", feed: "http://feeds.bbci.co.uk/sport/rss.xml" },
} as const;

export type NewsTopic = keyof typeof NEWS_TOPICS;

export interface Headline {
  topic: NewsTopic;
  title: string;
  link?: string;
}

export async function fetchHeadlines(
  topics: NewsTopic[],
  perTopic = 5
): Promise<Headline[]> {
  const results = await Promise.allSettled(
    topics.map(async (topic) => {
      const config = NEWS_TOPICS[topic];
      if (!config) return [];
      const feed = await parser.parseURL(config.feed);
      return (feed.items ?? []).slice(0, perTopic).map((item) => ({
        topic,
        title: item.title ?? "(untitled)",
        link: item.link,
      }));
    })
  );

  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}
