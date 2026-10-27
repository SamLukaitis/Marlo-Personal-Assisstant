import qrcode from "qrcode-generator";
import { waLink } from "./config";

// A scannable code for the WhatsApp chat, drawn as inline SVG so it needs no image file.
export function qrLink(className: string): HTMLAnchorElement {
  const qr = qrcode(0, "M");
  qr.addData(waLink());
  qr.make();
  const a = document.createElement("a");
  a.className = className;
  a.href = waLink();
  a.setAttribute("aria-label", "Scan to message Marlo on WhatsApp");
  a.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  return a;
}
