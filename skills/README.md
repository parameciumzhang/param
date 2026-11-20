# 角色专属 Skills

当前实际加载目录：

```text
skills/
├── manager/   # Manager：赛事资料归纳与拆题流程
├── worker/    # Worker：各 Challenge 共用的静态执行技术
└── planner/   # 保留目录，但多题 Planner 当前禁用 skills/read/bash
```

在 Manager 或 Worker 目录中为每个技能新建 `<skill-name>/SKILL.md`：

```markdown
---
name: example-skill
description: 说明技能能做什么，以及什么任务应使用它。
---

# Example skill

在这里编写具体步骤。引用的相对路径以此技能目录为基准。
```

技能目录可包含 `references/`、`assets/`、`scripts/`。frontmatter 必须含合法的 `name` 和同时说明能力/适用场景的 `description`。每次创建 Agent 都重新扫描，日志会打印实际技能与格式告警。

技能只是静态流程指导，不能包含某道题的运行时数据，也不能扩大 asset、违反 customization 或绕过固定脚本。多题 Planner 不开放通用 read/bash，扩展/MCP 可由角色开关独立启用，但 Planner skills 仍不加载；其中断轮与 Compactor 同样不加载 skills。

Worker 的 Kali 命令经 `kali_bash`，普通本地命令经 `bash`。container 模式下，宿主机 `skills/` 不挂载进 Kali，辅助文件应先放入任务工作区再从 `/work/task-<id>/` 使用；embedded 模式下内置 bash 与 `kali_bash` 共用 `<PARAM_OUTPUT_DIR>/workspaces/task-<id>/`。两种模式都可通过 `/wordlists` 使用字典。
