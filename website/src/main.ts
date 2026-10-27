import "./styles.css";
import { scenes } from "./script";
import { renderThread } from "./render";
import { renderNumberBlocks } from "./numberBlocks";
import { initScroll } from "./scroll";

renderNumberBlocks();
const thread = document.getElementById("thread")!;
renderThread(thread, scenes);
initScroll(thread);
