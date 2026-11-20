# 赛事提示词文件

在 `input/ctf.txt` 中填写整场 CTF 赛事与赛题描述，再执行 `npm run image:package`，内容会固化到镜像的 `/input/ctf.txt`。默认文件为空，不会触发空赛事启动。

也可以运行镜像时只读挂载覆盖：

```bash
-v "$PWD/input/ctf.txt:/input/ctf.txt:ro"
```

文件与 `CTF_INPUT` 环境变量可以同时存在，编排器按“文件在前、环境变量在后”合并。`CTF_INPUT_FILE` 可指定其他文件路径。显式命令行赛事参数优先；`--continue` 不读取这两个新赛事输入。

提示词文件会进入 tar 镜像并可被提取，不要在其中写入 API Key 等密钥。
