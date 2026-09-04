# FNIRSI DPS-150 Web Console(开源 Web 上位机)

> **English:** [README.md](../README.md) · API: [docs/en/API.md](../en/API.md)

纯前端(Web Serial,Chromium 系浏览器)的 FNIRSI DPS-150/DPS-150P 数控电源上位机。
**非官方独立项目**,基于社区公开资料实现,仅供学习与自用,使用前请确认兼容性。

- 自动化 API 指南:`docs/zh/API.md`(中文)与 [docs/en/API.md](../en/API.md)(英文)

## 一键管理(Makefile)

依赖:node/npm、python3(+pyserial)、(自动化测试另需 playwright chromium)。`make doctor` 可体检并提示缺什么。

| 命令 | 作用 |
|---|---|
| `make up` | 一键启动:网页服务(4173)+ 串口桥(8787),打印访问地址(幂等) |
| `make down` | 停止两者 |
| `make status` / `make logs` | 服务状态 / 查看日志 |
| `make dev` | 前端开发服务器(vite dev,前台) |
| `make build` / `make typecheck` / `make test` | 构建 / 类型检查 / 单元测试 |
| `make smoke` | 无头冒烟(需先 `make up`,自动拉起网页) |
| `make ui-full-proxy` | 真机全 UI 自动化(经代理,headless) |
| `node e2e/edge.cjs`(需代理) | 边界套件:非法输入不写/自动任务互斥/忙时禁手控/tooltip/语言切换 |
| `make device-full` | 设备层全功能验证(含 1V/50mA 空载 RUN 段) |
| `make perm` | 放开 /dev/ttyACM0 权限(可能需要 sudo) |
| `make clean` / `make distclean` | 清理构建产物 / 连 node_modules 一起清理 |

参数可覆盖:`make up PORT=8080 BAUD=9600`;桥端口用 `WSPORT=…`。
浏览器使用:打开 `http://localhost:4173`,顶部连接方式选「代理(ws 桥)」即连真机。

## 快速开始

```bash
npm install
npm run dev        # 开发(用 Chrome/Edge 打开提示的地址,需 localhost/HTTPS)
npm test           # 协议层单测(帧/校验/流解析/FF 快照解码,含实机黄金向量)
npm run build      # 产物在 dist/
```

浏览器要求:桌面 Chrome / Edge(Chromium)等支持 [Web Serial](https://developer.chrome.com/articles/serial/) 的浏览器,并在安全上下文(https 或 localhost)打开。

## 架构与健壮性
- **活动状态机(Activity Gate)**:`idle / connecting / auto` 互斥管理连接与自动任务(序列/扫描/脚本),禁止并发任务与运行期手动写;停止=请求-确认制防死锁;断开先停任务。含单测。
- **防御式校验**:电压/电流输入即时校验(非法=红框+提示,不写入);序列/扫描/DSL 运行前逐行取值校验;输出/设定区分区与二次确认。
- **状态警示**:保护触发→灯带红色快速闪烁+高亮+悬停说明(OVP/OCP/OPP/OTP/LVP/CC/CV tooltip)。
- **i18n**:简体中文/English,底栏按钮或设置页语言下拉即时切换(整页按语言重建);壳层/仪表/页头/常用动作均已 key 化,长说明逐步补充中。

## 已实现(当前进度)

- 协议核心库:`src/protocol/` —— 帧编解码、校验和、字节流解析(校验失败重同步)、RX 分派、FF 139B 快照解码、寄存器常量;**22 个单测全绿**
- 串口传输:`src/serial/` —— WebSerial 封装(读写/错误/断开事件)
- 设备控制器:`src/device/controller.ts` —— 会话/初始化/信息查询、写后回读、写命令串行化、推送节拍统计
- 仪表页:连接、实时遥测大屏、状态灯(输出/CC-CV/保护)、设 V/A(上限钳制)、输出开关(带确认)、协议日志
- 记录页:实时曲线(可调窗口/暂停/清空)、长时采样记录(IndexedDB 会话,采样率与容量上限可调)、会话 CSV 导出、曲线 PNG/CSV 导出
- 预设页:M1–M6 编辑/保存槽位/应用到主设定;保护页:OVP/OCP/OPP/OTP/LVP 设置
- 扫描页:电压/电流扫描向导(步进+固定轴),运行前确认、VI 特性图、结果表与 CSV 导出
- 序列页:表格行(V,A,延时)执行器 —— 手动/自动(循环/起止序号),运行前确认、运行中不打断、设备异常按「设置」策略提示/暂停/停止,完成自动关输出
- 脚本页:编辑/语法检查/运行/停止、样例、保存/导入导出(主线程 async,可调完整 API)
- 设置页:主题/波特率/采样率/容量上限/确认强度/自动运行中断策略;配方管理(从设备保存、载入默认、撤销、删除、应用到设备)
- 存储:`src/storage/` —— localStorage 设置/配方(undo + load 默认)、IndexedDB 会话记录、CSV 导出
- 自动化 API:`window.dps150` + `docs/zh/API.md`/`docs/en/API.md`(连接/设定/输出/预设/保护/亮度音量/计量/快照/事件订阅)
- 主题:暗/亮,HP 仪器风(LED/LCD 读数、指示灯、面板质感),配色参照 [tinysa-webgen](https://git.sr.ht/~bytewolf/tinysa-webgen)(MIT)
- 界面预览截图(真机数据):见 `docs/screens/*.png`(仪表/预设/扫描/DSL 脚本/设置/曲线悬停,暗/亮与中/英)

## 待实现

曲线/事件标记、记录与导出界面、预设 M1–M6 与配方管理界面、保护阈值界面、长时采样会话、扫描/序列执行器、高级模式脚本区、多语言、断连/异常策略、自动运行监控中断策略等。

## 真机浏览器联调(WebSerial 需要设备对浏览器所在 OS 可见)

WebSerial 只能访问**浏览器所在操作系统**枚举到的 USB 串口:

- Windows 侧 Chrome/Edge:若设备被 usbipd 绑定到 WSL,先执行
  `usbipd list` 找到设备,`usbipd attach --wsl --busid <BUSID>`(把绑定切回 Windows,`--wsl` 用 wsl 侧时省略),然后浏览器打开 `http://localhost:4173` → 连接设备 → 选择 DPS-150。
- 若在 WSLg 内运行 Linux Chrome:设备以 `/dev/ttyACM0` 出现,可先尝试直接连接;若 Chrome 枚举不到,用 Windows 侧方案。
- 连接后请先在低电压/小电流 + 空载下验证「仪表→设定→输出开关」闭环(带确认)。

## WSL 环境备注与串口代理

- WSL 下 Chrome WebSerial 对该设备存在"首次成功后读通道假死"的问题(写正常、读为空;拔插/权限复位都不能稳定恢复)。日常使用可改用 Windows 侧 Chrome + usbipd;**自动化测试走本地串口代理**:
  ```bash
  node tools/bridge.cjs 115200 8787            # 串口 -> WebSocket(依赖 pyserial)
  PROXY=1 node e2e/ui-full.cjs                  # 全 UI 功能验证(真机,headless)
  python3 tools/selftest_full.py --run-test     # 设备层全功能验证
  ```
  浏览器手动使用:页面顶部「连接方式」选择 **代理(ws 桥)** 并填 `ws://127.0.0.1:8787`(无需改 URL,选择会被记住);USB 直连则选 **USB(WebSerial)**。旧用法 `?proxy=ws://…` 仍兼容。
- 设备权限:每次拔插后节点常回到 root:600,先 `sudo chmod 666 /dev/ttyACM0`。

## 真机联调辅助(仓库 `tools/`)

Python 实机工具(需 pyserial),用于协议验证与回归:

```bash
python3 tools/devtest.py --seconds 6     # 被动:会话/信息/FF 变体/遥测观察/安全写读回
python3 tools/probe_regs.py              # 写-读回矩阵:保护/亮度/音量/计量/预设/回显
python3 tools/probe_run.py               # 输出开合观察(需人工确认安全)
```

> ⚠️ 真机验证请在**空载/低电压/小电流限/输出关闭**前提下进行;任何输出使能测试需先确认负载与接线安全。工具默认在输出 RUN 时跳过写测试。

## 免责与致谢

- 非官方项目;FNIRSI 为深圳市菲尼瑞斯科技有限公司注册商标,本项目与其无隶属关系。
- 参考与致谢:[tinysa-webgen](https://git.sr.ht/~bytewolf/tinysa-webgen)(主题配色,MIT)、[cho45/fnirsi-dps-150](https://github.com/cho45/fnirsi-dps-150)(协议实机验证,MIT)、[miuser00/fnirst-power-cli](https://github.com/miuser00/fnirst-power-cli)(协议参考,MIT)。
- 使用本项目对真实负载进行操作后果自负(与 CLI/官方类似请自担责任)。
