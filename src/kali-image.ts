import { spawn } from "node:child_process";
import path from "node:path";
import { config } from "./config.js";

/** npm run kali:image —— 用 docker/kali/Dockerfile 构建预装全量工具的镜像（tag: param-kali-ctf）。 */
const tag = process.env.IMAGE_TAG ?? "param-kali-ctf";
const args = ["build", "-t", tag];
if (config.kali.aptMirror) args.push("--build-arg", `APT_MIRROR=${config.kali.aptMirror}`);
args.push("--build-arg", `KALI_PACKAGES=${config.kali.packages.join(" ")}`);
args.push("-f", path.join("docker", "kali", "Dockerfile"), path.join("docker", "kali"));

console.log(`[kali-image] docker ${args.join(" ")}`);
const child = spawn("docker", args, { cwd: config.root, stdio: "inherit" });
child.on("exit", (code) => {
  if (code === 0) {
    console.log(`[kali-image] 构建完成: ${tag}`);
    console.log(`[kali-image] 使用: .env 设 KALI_IMAGE=${tag}`);
    console.log(`[kali-image] 分发: npm run kali:export 导出 tar，目标机 npm run kali:import 导入`);
    process.exit(0);
  }
  console.error(`[kali-image] 构建失败（exit ${code}）`);
  process.exit(code ?? 1);
});
