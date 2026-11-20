import fs from "node:fs";
import { config } from "./config.js";

export interface ContestInputOptions {
  filePath?: string;
  envInput?: string;
  /** 用户显式设置 CTF_INPUT_FILE 后，缺失文件是配置错误；默认文件缺失则仅表示未使用。 */
  requireFile?: boolean;
}

/** 文件与环境变量可以共存：文件在前、环境变量在后；仅一个来源时保持原文。 */
export function combineContestInputs(fileInput?: string, envInput?: string): string | undefined {
  const file = fileInput?.trim() ?? "";
  const env = envInput?.trim() ?? "";
  if (file && env) {
    return [
      "<<<CTF_INPUT_FILE",
      file,
      "CTF_INPUT_FILE>>>",
      "",
      "<<<CTF_INPUT",
      env,
      "CTF_INPUT>>>",
    ].join("\n");
  }
  return file || env || undefined;
}

/** 读取可选赛事输入；文件正文与 env 都只作为不可信 Manager 输入，不执行其中命令。 */
export function loadContestInput(opts: ContestInputOptions = {}): string | undefined {
  const filePath = opts.filePath ?? config.contestInputFile;
  let fileInput: string | undefined;
  if (fs.existsSync(filePath)) {
    try {
      fileInput = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      throw new Error(`无法读取 CTF_INPUT_FILE=${filePath}: ${(error as Error).message}`);
    }
  } else if (opts.requireFile) {
    throw new Error(`CTF_INPUT_FILE 指定的提示词文件不存在: ${filePath}`);
  }
  return combineContestInputs(fileInput, opts.envInput ?? process.env.CTF_INPUT);
}
