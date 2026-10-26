import type { Scene } from "./script";

const SCENE_LABELS: Record<Scene["id"], string> = {
  email: "Conversation about sorting email",
  travel: "Conversation about comparing travel options",
  itinerary: "Conversation about planning an itinerary",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderThread(root: HTMLElement, scenes: Scene[]): void {
  root.replaceChildren();
  for (const scene of scenes) {
    const section = el("section", "scene");
    section.id = scene.id;
    const list = el("ol", "thread");
    list.setAttribute("aria-label", SCENE_LABELS[scene.id]);
    for (const m of scene.messages) {
      const li = el("li", `msg msg--${m.from}`);
      li.append(
        el("span", "sr-only", m.from === "you" ? "You said: " : "Marlo said: "),
        el("span", "msg__text", m.text),
        el("time", "msg__time", m.time)
      );
      list.append(li);
    }
    section.append(list);
    root.append(section);
  }
}
