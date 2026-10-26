import { PHONE_DISPLAY, waLink } from "./config";

const LABEL = "Message Marlo on WhatsApp";

function numberLink(className: string, text: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = className;
  a.href = waLink();
  a.textContent = text;
  a.setAttribute("aria-label", LABEL);
  return a;
}

function paragraph(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
}

// The number appears three times: huge at the top, pinned in a slim bar, and once more to close.
export function renderNumberBlocks(): void {
  const hero = document.getElementById("hero")!;
  hero.replaceChildren(
    paragraph("Marlo sorts your email and plans your trips."),
    numberLink("number number--hero", PHONE_DISPLAY),
    paragraph("Message it on WhatsApp.")
  );

  const bar = document.getElementById("bar")!;
  bar.replaceChildren(numberLink("bar__number", PHONE_DISPLAY), numberLink("bar__message", "Message"));

  const close = document.getElementById("close")!;
  close.replaceChildren(numberLink("number number--close", PHONE_DISPLAY));
}
