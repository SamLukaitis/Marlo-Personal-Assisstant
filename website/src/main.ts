import { scenes } from "./script";
import { renderThread } from "./render";
import { renderNumberBlocks } from "./numberBlocks";

renderNumberBlocks();
renderThread(document.getElementById("thread")!, scenes);
