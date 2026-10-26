import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger);

export function shouldAnimate(): boolean {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Messages appear one at a time as they near the middle of the screen. The hidden state is only
// ever applied from here, so a visitor without JavaScript, or with reduced motion, sees everything.
export function initScroll(root: HTMLElement): () => void {
  if (!shouldAnimate()) return () => {};

  const messages = [...root.querySelectorAll<HTMLElement>("li.msg")];
  messages.forEach((m) => m.classList.add("is-pending"));

  const lenis = new Lenis();
  lenis.on("scroll", ScrollTrigger.update);
  const tick = (time: number) => lenis.raf(time * 1000);
  gsap.ticker.add(tick);
  gsap.ticker.lagSmoothing(0);

  const reveal = (batch: Element[]) => {
    batch.forEach((el) => el.classList.remove("is-pending"));
    gsap.fromTo(
      batch,
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.35, ease: "power2.out", stagger: 0.12, clearProps: "opacity,transform" }
    );
  };

  const triggers = ScrollTrigger.batch(messages, {
    start: "top 88%",
    once: true,
    onEnter: reveal,
  });

  // Anything already above the screen on load, refresh or a jump is shown at once, never left hidden.
  const showPassed = () => {
    messages
      .filter((m) => m.classList.contains("is-pending") && m.getBoundingClientRect().bottom < 0)
      .forEach((m) => m.classList.remove("is-pending"));
  };
  showPassed();
  ScrollTrigger.addEventListener("refresh", showPassed);

  return () => {
    ScrollTrigger.removeEventListener("refresh", showPassed);
    triggers.forEach((t) => t.kill());
    gsap.ticker.remove(tick);
    lenis.destroy();
    messages.forEach((m) => m.classList.remove("is-pending"));
  };
}
