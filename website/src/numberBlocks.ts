import { PHONE_DISPLAY, waLink } from "./config";
import { qrLink } from "./qr";
import { scenes } from "./script";

const LABEL = "Message Marlo on WhatsApp";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function numberLink(className: string, text: string): HTMLAnchorElement {
  const a = el("a", className, text);
  a.href = waLink();
  a.setAttribute("aria-label", LABEL);
  return a;
}

// The number in a card with the QR code beside it on screens wide enough to scan from a phone.
function contact(numberClass: string, note: string): HTMLElement {
  const card = el("div", "contact");
  const scan = el("div", "contact__scan");
  scan.append(qrLink("qr"));
  const text = el("div", "contact__text");
  text.append(el("p", "contact__label", "Scan, or message"), numberLink(numberClass, PHONE_DISPLAY), el("p", "contact__note", note));
  card.append(scan, text);
  return card;
}

// The page's own furniture around the phone: top bar, landing hero, captions, what Marlo does, closing.
export function renderNumberBlocks(): void {
  const bar = document.getElementById("bar")!;
  bar.replaceChildren(
    el("span", "bar__name", "Marlo"),
    numberLink("bar__number", PHONE_DISPLAY),
    numberLink("bar__message", "Message")
  );

  const hero = document.getElementById("hero")!;
  const inner = el("div", "hero__inner");
  inner.append(
    el("p", "hero__kicker", "Your assistant on WhatsApp"),
    el("h1", "hero__name", "Marlo"),
    el("p", "hero__lede", "Marlo sorts your email, keeps your documents and reminds you what is coming up. Just send it a message."),
    contact("number number--hero", "On WhatsApp. No signup."),
    el("p", "hero__scroll", "Scroll to see it work")
  );
  hero.replaceChildren(inner);

  const captions = document.getElementById("captions")!;
  captions.replaceChildren(
    ...scenes.map((s) => {
      const c = el("div", "caption");
      c.dataset.scene = s.id;
      c.append(el("h2", "caption__title", s.heading), el("p", "caption__body", s.caption));
      return c;
    })
  );

  const does = document.getElementById("does")!;
  const list = el("ul", "does__list");
  for (const s of scenes) {
    const li = el("li", "does__item reveal");
    li.append(el("h3", undefined, s.heading), el("p", undefined, s.caption));
    list.append(li);
  }
  does.replaceChildren(el("h2", "does__title reveal", "Ask it like you'd ask a person."), list);

  const close = document.getElementById("close")!;
  close.replaceChildren(
    el("p", "close__lede", "Ready when you are."),
    contact("number number--close", "On WhatsApp. No signup.")
  );
}
