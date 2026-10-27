import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger);

export function shouldAnimate(): boolean {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Timeline units: the phone rises for ENTER, each chat item takes STEP, then the phone rests for HOLD.
const ENTER = 1;
const STEP = 1;
const HOLD = 1.5;

// Pins the phone while the scroll plays the conversation, and fades the page's other blocks in.
// Hidden states are only ever applied from here, so a visitor without JavaScript, or with reduced
// motion, sees everything (the chat is then a scrollable phone).
export function initScroll(root: HTMLElement): () => void {
  if (!shouldAnimate()) return () => {};

  const phone = document.getElementById("phone");
  const items = [...root.querySelectorAll<HTMLElement>(".chip, li.msg")];
  const reveals = [...document.querySelectorAll<HTMLElement>(".reveal")];
  items.forEach((m) => m.classList.add("is-pending"));
  reveals.forEach((m) => m.classList.add("is-pending"));

  const lenis = new Lenis({ lerp: 0.085, wheelMultiplier: 0.9 });
  lenis.on("scroll", ScrollTrigger.update);
  const tick = (time: number) => lenis.raf(time * 1000);
  gsap.ticker.add(tick);
  gsap.ticker.lagSmoothing(0);

  const revealTriggers = ScrollTrigger.batch(reveals, {
    start: "top 90%",
    once: true,
    onEnter: (batch) => {
      batch.forEach((el) => el.classList.remove("is-pending"));
      gsap.fromTo(
        batch,
        { opacity: 0, y: 24 },
        { opacity: 1, y: 0, duration: 0.7, ease: "power3.out", stagger: 0.12, clearProps: "opacity,transform" }
      );
    },
  });

  let timeline: gsap.core.Timeline | undefined;
  const captions = [...document.querySelectorAll<HTMLElement>(".caption")];
  if (phone && items.length) {
    const screen = root.parentElement as HTMLElement;
    const phoneEl = phone.querySelector<HTMLElement>(".phone")!;
    phone.classList.add("is-scrub");
    phone.style.setProperty("--beats", String(ENTER + items.length * STEP + HOLD));

    // Where the chat must sit so item i is the last thing visible, just above the input bar.
    const restAt = (i: number) => {
      const el = items[i];
      return Math.min(0, screen.clientHeight - (el.offsetTop + el.offsetHeight) - 14);
    };
    const sceneOf = items.map((el) => el.closest(".scene")?.id ?? "");
    const setActive = (progress: number, total: number) => {
      const i = Math.max(0, Math.min(items.length - 1, Math.floor((progress * total - ENTER) / STEP + 0.4)));
      captions.forEach((c) => c.classList.toggle("is-active", c.dataset.scene === sceneOf[i]));
    };
    const total = ENTER + items.length * STEP + HOLD;
    setActive(0, total);

    timeline = gsap.timeline({
      scrollTrigger: {
        trigger: phone,
        start: "top top",
        end: "bottom bottom",
        scrub: 0.6,
        invalidateOnRefresh: true,
        onUpdate: (self) => setActive(self.progress, total),
      },
    });
    timeline.fromTo(phoneEl, { y: 120, scale: 0.86 }, { y: 0, scale: 1, duration: ENTER, ease: "power2.out" }, 0);
    items.forEach((el, i) => {
      const at = ENTER + i * STEP;
      timeline!.fromTo(
        el,
        { opacity: 0, y: 14, scale: 0.97 },
        { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: "power2.out" },
        at
      );
      timeline!.fromTo(
        root,
        { y: () => (i ? restAt(i - 1) : 0) },
        { y: () => restAt(i), duration: 0.6, ease: "power2.out", immediateRender: i === 0 },
        at
      );
    });
    timeline.to({}, { duration: HOLD }, ENTER + items.length * STEP);
  }

  // Anything already above the screen on load, refresh or a jump is shown at once, never left hidden.
  const showPassed = () => {
    reveals
      .filter((m) => m.classList.contains("is-pending") && m.getBoundingClientRect().bottom < 0)
      .forEach((m) => m.classList.remove("is-pending"));
  };
  showPassed();
  ScrollTrigger.addEventListener("refresh", showPassed);

  return () => {
    ScrollTrigger.removeEventListener("refresh", showPassed);
    revealTriggers.forEach((t) => t.kill());
    timeline?.scrollTrigger?.kill();
    timeline?.kill();
    gsap.ticker.remove(tick);
    lenis.destroy();
    gsap.set([...items, root, ...(phone ? phone.querySelectorAll(".phone") : [])], { clearProps: "all" });
    phone?.classList.remove("is-scrub");
    captions.forEach((c) => c.classList.remove("is-active"));
    [...items, ...reveals].forEach((m) => m.classList.remove("is-pending"));
  };
}
