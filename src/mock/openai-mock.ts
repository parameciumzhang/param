import http from "node:http";

/** 确定性 OpenAI 兼容 mock：验证多 Challenge 编排，不执行真实渗透。 */
interface ChatMessage {
  role: string;
  content: string | Array<{ type?: string; text?: string }> | null;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}
interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

let callSeq = 0;
const observedTools = new Map<string, Set<string>>();
const plannerContexts: string[] = [];
const workerContexts: string[] = [];
let compactorBatchCount = 0;

type Scenario = "normal" | "force" | "manager-noop" | "manager-no-finish" | "ctrl-c" | "embedded" | "complete-task" | "incremental" | "wait-no-events";
function scenario(): Scenario {
  const value = process.env.MOCK_SCENARIO;
  return ["force", "manager-noop", "manager-no-finish", "ctrl-c", "embedded", "complete-task", "incremental", "wait-no-events"].includes(value ?? "") ? value as Scenario : "normal";
}
function textContent(content: ChatMessage["content"] | undefined): string {
  return typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join("") : "";
}
function mk(name: string, args: unknown): ToolCall {
  return { id: `call_${++callSeq}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

export function resetMockObservations(): void {
  observedTools.clear();
  plannerContexts.length = 0;
  workerContexts.length = 0;
  compactorBatchCount = 0;
}
export function observedToolNames(model: string, role?: "manager" | "planner" | "worker" | "compactor"): string[] {
  return [...(observedTools.get(role ? `${model}:${role}` : model) ?? [])].sort();
}
export function observedPlannerContexts(): string[] { return [...plannerContexts]; }
export function observedWorkerContexts(): string[] { return [...workerContexts]; }
export function observedCompactorBatchCount(): number { return compactorBatchCount; }

function decide(messages: ChatMessage[]): { text?: string; toolCalls: ToolCall[] } {
  const system = textContent(messages.find((message) => message.role === "system" || message.role === "developer")?.content);
  const user = textContent([...messages].reverse().find((message) => message.role === "user")?.content);
  const toolResults = messages.filter((message) => message.role === "tool");

  if (system.includes("**Manager**（目标管理者）")) {
    if (scenario() === "manager-noop") return { text: "模拟 Manager 空跑", toolCalls: [] };
    const started = messages.some((message) => message.tool_calls?.some((call) => call.function?.name === "start_contest"));
    if (!started) {
      return { toolCalls: [mk("start_contest", {
        asset: "mock-ctf contest",
        customization: "仅限 mock 授权范围；禁止破坏性操作",
        goal: "完成全部信息充足的 mock CTF 赛题",
      })] };
    }
    const alpha = { name: "Alpha", asset: "alpha.mock.test", customization: "ALPHA-ONLY", goal: "获得 ALPHA-FLAG" };
    const beta = { name: "Beta", asset: "beta.mock.test", customization: "BETA-ONLY", goal: "获得 BETA-FLAG" };
    const gamma = { name: "Gamma", asset: "gamma.mock.test", customization: "GAMMA-ONLY", goal: "获得 GAMMA-FLAG" };
    const insufficient = { name: "Insufficient", asset: "", goal: "", skip_reason: "mock 赛题缺少附件与目标" };
    const batches = scenario() === "complete-task"
      ? [[alpha]]
      : scenario() === "incremental"
        ? [[alpha], [beta, gamma, insufficient]]
        : [[alpha, beta], [gamma, insufficient]];
    const published = messages.filter((message) => message.tool_calls?.some((call) => call.function?.name === "publish_challenges")).length;
    if (published < batches.length) return { toolCalls: [mk("publish_challenges", { challenges: batches[published] })] };
    const finished = messages.some((message) => message.tool_calls?.some((call) => call.function?.name === "finish_challenge_publication"));
    if (!finished && scenario() !== "manager-no-finish") return { toolCalls: [mk("finish_challenge_publication", {})] };
    return { text: finished ? "Manager 已完成增量发布。" : "模拟 Manager 遗漏发布收尾", toolCalls: [] };
  }

  if (system.includes("**Planner**（")) {
    plannerContexts.push(user);
    if (user.includes("<<<INTERRUPTED_SHUTDOWN")) {
      return toolResults.length
        ? { text: "本题中断报告已生成", toolCalls: [] }
        : { toolCalls: [mk("generate_report", { conclusion: "本题 Ctrl+C 阶段性结果；未完成任务保持未完成。" })] };
    }
    const done = (user.match(/\[已完成\]/g) ?? []).length;
    const pending = (user.match(/\[未完成\]/g) ?? []).length;
    const challenge = user.match(/Challenge #(\d+)（([^）]+)）/);
    const challengeName = challenge?.[2] ?? "Unknown";
    if (!user.includes("## 任务 #")) {
      const inserted = messages.some((message) => message.tool_calls?.some((call) => call.function?.name === "insert_task"));
      if (inserted) return { text: "本题引导任务已发布", toolCalls: [] };
      return { toolCalls: (scenario() === "complete-task" ? [1, 2, 3] : [1, 2]).map((index) => mk("insert_task", {
        task: `${challengeName}-TASK-${index}${scenario() === "force" && index === 2 ? " FAIL-ME" : ""}：验证本题 mock 目标并记录结果`,
        note: `${challengeName}-NOTE-${index}：完成后据本题结果进入终态`,
      })) };
    }
    if (pending > 0) {
      if (scenario() === "complete-task" && done > 0) {
        const forced = messages.some((message) => message.tool_calls?.some((call) => call.function?.name === "force_complete_task"));
        if (forced) return { text: "已强制完成长扫描任务", toolCalls: [] };
        const pendingIds = [...user.matchAll(/## 任务 #(\d+) \[未完成\]/g)].map((match) => Number(match[1]));
        if (pendingIds.length > 0) return { toolCalls: [...pendingIds.map((taskId) => mk("force_complete_task", { task_id: taskId })), mk("wait_for_next_event", {})] };
      }
      if (toolResults.length) return { text: "等待本题 Worker", toolCalls: [] };
      return { toolCalls: [mk("wait_for_next_event", {})] };
    }
    if (done >= 2) {
      if (scenario() === "wait-no-events" && /本题待处理内部完成事件: #/.test(user)) {
        const waited = messages.some((message) => message.tool_calls?.some((call) => call.function?.name === "wait_for_next_event"));
        return waited
          ? { text: "最后完成事件已消费，本题等待不会再到来的内部事件", toolCalls: [] }
          : { toolCalls: [mk("wait_for_next_event", {})] };
      }
      const reported = messages.some((message) => message.tool_calls?.some((call) => call.function?.name === "generate_report"));
      return reported
        ? { text: "本题报告已生成", toolCalls: [] }
        : { toolCalls: [mk("generate_report", { conclusion: `${challengeName}-CONCLUSION：本题 mock 任务均已完成。` })] };
    }
    return { text: "本题无额外规划", toolCalls: [] };
  }

  if (system.includes("**Worker**（")) {
    workerContexts.push(user);
    const assigned = user.match(/任务 #(\d+)：\s*\n任务内容:\s*([^\n]+)/);
    const taskId = Number(assigned?.[1] ?? 1);
    const taskText = assigned?.[2] ?? "";
    if (scenario() === "force" && taskText.includes("FAIL-ME")) {
      return { text: "模拟 Worker 不收尾", toolCalls: [] };
    }
    const completed = messages.some((message) => message.tool_calls?.some((call) => call.function?.name === "complete_task"));
    if (completed) return { text: `任务 #${taskId} 已完成`, toolCalls: [] };
    if (toolResults.length) return { toolCalls: [mk("complete_task", {})] };
    const calls = [
      mk("write_fact", { fact: `TASK-${taskId}-FACT`, fact_detail: `任务 ${taskId} 的本题详细事实；不得出现在其他赛题。` }),
      mk("write_finding", { finding: `TASK-${taskId}-FINDING：mock 验证完成` }),
    ];
    if (scenario() === "ctrl-c") {
      calls.push(mk("bash", { command: "node -e \"console.log('MOCK-WORKER-READY'); setTimeout(() => console.log('MOCK-SCAN-FINISHED'), 30000)\"" }));
    } else if (scenario() === "complete-task" && /TASK-[23]/.test(taskText)) {
      calls.push(mk("bash", { command: "node -e \"setTimeout(() => require('node:fs').writeFileSync('.mock-scan-finished', 'late'), 3000)\"" }));
    } else if (scenario() === "embedded") {
      calls.push(mk("kali_bash", { command: "printf '%s' \"$PWD\" > .mock-kali-ok && test -r /wordlists/README.md" }));
    } else {
      calls.push(mk("bash", { command: "node -e \"require('node:fs').writeFileSync('.mock-worker-ok', String(process.cwd()))\"" }));
    }
    return { toolCalls: calls };
  }

  if (system.includes("**Compactor**（")) {
    if (toolResults.length) return { text: "压缩完成", toolCalls: [] };
    const match = user.match(/<<<TASK_COMPRESSION_INPUT\s*([\s\S]*?)\s*TASK_COMPRESSION_INPUT>>>/);
    if (!match) return { text: "缺少压缩输入", toolCalls: [] };
    const input = JSON.parse(match[1]) as Array<{ task_id: number; task: string; finding: string | null }>;
    compactorBatchCount++;
    return { toolCalls: [mk("compress_task_batch", { items: input.map((row) => ({
      task_id: row.task_id,
      task: `任务${row.task_id}摘要`.slice(0, 30),
      findings: row.finding ? [`任务${row.task_id}发现摘要`.slice(0, 100)] : [],
    })) })] };
  }

  return { text: "未知角色", toolCalls: [] };
}

function chunk(delta: Record<string, unknown>, finishReason: string | null, model: string) {
  return {
    id: `chatcmpl-mock-${++callSeq}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function startMock(port = Number(process.env.MOCK_PORT ?? 8787)): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mock-pentest-model" }] }));
      return;
    }
    if (!url.endsWith("/chat/completions")) {
      res.writeHead(404); res.end("not found"); return;
    }
    let body = "";
    req.on("data", (data) => body += data);
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body) as {
          messages: ChatMessage[]; stream?: boolean; model?: string;
          tools?: Array<{ function?: { name?: string } }>;
        };
        const model = parsed.model ?? "mock-pentest-model";
        const tools = observedTools.get(model) ?? new Set<string>();
        for (const tool of parsed.tools ?? []) tools.add(tool.function?.name ?? "?");
        observedTools.set(model, tools);
        const requestSystem = textContent(parsed.messages.find((message) => message.role === "system" || message.role === "developer")?.content);
        if (scenario() === "incremental" && requestSystem.includes("**Manager**（")) {
          const messages = parsed.messages ?? [];
          const started = messages.some((message) => message.tool_calls?.some((call) => call.function?.name === "start_contest"));
          const published = messages.filter((message) => message.tool_calls?.some((call) => call.function?.name === "publish_challenges")).length;
          if (started && published === 1) await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
        const decision = decide(parsed.messages ?? []);
        const role = requestSystem.includes("**Manager**（") ? "manager"
          : requestSystem.includes("**Planner**（") ? "planner"
            : requestSystem.includes("**Worker**（") ? "worker"
              : requestSystem.includes("**Compactor**（") ? "compactor" : undefined;
        if (role) {
          const roleTools = observedTools.get(`${model}:${role}`) ?? new Set<string>();
          for (const tool of parsed.tools ?? []) roleTools.add(tool.function?.name ?? "?");
          observedTools.set(`${model}:${role}`, roleTools);
        }
        if (parsed.stream) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          const send = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
          if (decision.text) send(chunk({ role: "assistant", content: decision.text }, null, model));
          decision.toolCalls.forEach((call, index) => send(chunk({ role: "assistant", tool_calls: [{ index, ...call }] }, null, model)));
          send(chunk({}, decision.toolCalls.length ? "tool_calls" : "stop", model));
          res.write("data: [DONE]\n\n"); res.end();
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: `chatcmpl-mock-${++callSeq}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, message: { role: "assistant", content: decision.text ?? null, tool_calls: decision.toolCalls.length ? decision.toolCalls : undefined }, finish_reason: decision.toolCalls.length ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }));
        }
      } catch (e) {
        console.error(`[mock] ${(e as Error).stack ?? e}`);
        res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: (e as Error).message } }));
      }
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1]?.includes("openai-mock")) {
  const port = Number(process.env.MOCK_PORT ?? 8787);
  startMock(port).then(() => console.log(`mock OpenAI 兼容端点: http://127.0.0.1:${port}/v1`));
}
