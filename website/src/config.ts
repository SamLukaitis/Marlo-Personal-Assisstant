// Marlo's WhatsApp number. The only place it is written down; everything on the page reads from here.
export const PHONE_DISPLAY = "+44 7552 639982";
export const PHONE_E164_DIGITS = "447552639982";

export function waLink(): string {
  return `https://wa.me/${PHONE_E164_DIGITS}`;
}
