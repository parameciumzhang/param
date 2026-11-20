import { ensureKali } from "./kali.js";

/** 独立预装入口：npm run kali:setup —— 提前拉镜像/建容器/装工具，编排运行时秒级复用。 */
ensureKali((s) => console.log(s)).then(
  () => {
    console.log("Kali 执行环境就绪。");
    process.exit(0);
  },
  (e) => {
    console.error(`Kali 准备失败: ${(e as Error).stack ?? e}`);
    process.exit(1);
  }
);
