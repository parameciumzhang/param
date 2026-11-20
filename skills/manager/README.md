# Manager Skills

此目录仅由 **Manager** 加载。为每个技能创建 `<skill-name>/SKILL.md`，补充赛事资料归纳、Challenge 拆分和信息充分性判断流程。

Manager 可用 `read` 读取技能及用户明确指定的资料，用宿主机 `bash` 只读获取用户指定的远程任务页；不开放 edit/write。业务动作只能调用 `save_contest_challenges` 与 `inject_prompts`。技能不得替用户臆测赛题资产、目标或授权范围，也不能指定 Challenge ID/状态或控制调度。

通用格式见 [../README.md](../README.md)。
