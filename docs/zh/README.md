# FNIRSI DPS-150 Web Console

面向 **FNIRSI DPS-150 / DPS-150P** 数控电源的**纯前端** Web 上位机。基于支持 [Web Serial](https://developer.chrome.com/articles/serial/) 的 Chromium 系浏览器——无需后端、无需安装,打开页面即可驱动设备。

> **非官方项目。** FNIRSI 为深圳市菲尼瑞斯科技有限公司注册商标。本项目为独立社区工具,基于公开社区资料实现,与厂家无隶属关系、未经授权,准确性与可靠性不作保证。**使用请自担风险。**
>
> 🇬🇧 English: [README.md](../../README.md) · 📖 自动化 API: [API.md](API.md) / [English API](../en/API.md)

## 界面截图

<details>
<summary>点击查看截图</summary>

**硬件连接**(DPS-150P + 电脑,通过 USB):

![硬件连接](../screens/fnirsi_power_supply_webcon_setup.jpg)

**实时仪表**(真机数据,带载 12 V / 0.11 A):

![仪表](../screens/01-dashboard-dark.png)

**实时曲线**(负载接入时的电压台阶):

![曲线](../screens/07-chart-hover-dark.png)

**预设 / 扫描 / DSL 脚本 / 设置**:

![预设](../screens/03-presets-dark.png)
![扫描](../screens/04-scan-dark.png)
![脚本](../screens/05-script-dsl-dark.png)
![设置](../screens/06-settings-dark.png)

</details>

## 特性亮点

- **实时仪表**——电压 / 电流 / 功率 / 温度实时显示,状态灯(输出、CV/CC 模式、保护),设定值输入(上限钳制),输出带二次确认。
- **长时记录**——曲线可调显示窗口(拖动平移/滚轮缩放),IndexedDB 会话(秒级到一周,自适应降采样),CSV 导出。
- **预设与保护**——编辑/保存 M1–M6 并应用到主设定;配置 OVP/OCP/OPP/OTP/LVP 阈值。
- **扫描**——电压/电流扫描向导(步进+固定轴),运行前确认,V-I 特性图、结果表与 CSV 导出。
- **序列执行器**——(V,A,延时)表格步骤,手动/自动(循环/起止序号),运行前确认、安全中断、完成自动关输出。
- **DSL 脚本区**——编辑/语法检查/运行/停止,内置样例,保存/导入导出,完整异步控制 API。
- **设置**——主题(暗/亮)、波特率、采样率、会话容量、确认强度、自动运行中断策略;配方管理。
- **自动化 API**——浏览器控制台 `window.dps150`(连接/设定/输出/预设/保护/亮度音量/计量/快照/事件)。
- **i18n**——简体中文 / English。

## 快速开始

```bash
npm install
npm run dev        # 开发(Chrome/Edge,需 localhost/https)
npm test           # 单测
npm run build      # 产物在 dist/
```

打开提示地址,顶部选择 **USB(Web Serial)**(或串口桥),连接设备。请始终在**空载/低电压/小电流**状态下先测试。

## 一键管理(Makefile)

依赖:node/npm、python3(+pyserial)、自动化测试另需 playwright chromium。`make doctor` 体检并提示缺什么。

| 命令 | 作用 |
|---|---|
| `make up` | 启动网页服务(4173)+ 串口桥(8787),打印地址(幂等) |
| `make down` | 停止两者 |
| `make status` / `make logs` | 服务状态 / 查看日志 |
| `make dev` | 前端开发服务器(vite dev,前台) |
| `make build` / `make typecheck` / `make test` | 构建 / 类型检查 / 单测 |
| `make smoke` | 无头冒烟(需 `make up`) |
| `make ui-full-proxy` | 真机全 UI 自动化(经代理,headless) |
| `node e2e/edge.cjs`(需代理) | 边界套件:非法输入不写/自动任务互斥/忙时禁手控/tooltip/语言切换 |
| `make device-full` | 设备层全功能验证(含 1V/50mA 空载 RUN) |
| `make perm` | 放开 /dev/ttyACM0 权限(可能需要 sudo) |
| `make clean` / `make distclean` | 清理构建产物 / 连 node_modules 一起清理 |

可用 `make up PORT=8080 BAUD=9600` 覆盖;桥端口用 `WSPORT=…`。

## 架构与健壮性

- **活动状态机**——`idle / connecting / auto` 对连接与自动任务(序列/扫描/脚本)互斥管理;禁止并发任务与运行期手动写;停止采用请求-确认制防死锁;断开先停任务。含单测。
- **防御式校验**——电压/电流输入即时校验(非法=红框+提示,不写入);序列/扫描/DSL 运行前逐行校验;输出/设定分离并二次确认。
- **状态警示**——保护触发→状态灯红色快速闪烁+高亮+悬停说明(OVP/OCP/OPP/OTP/LVP/CC/CV)。
- **i18n**——简体中文 / English,底栏按钮或设置页语言下拉切换。

## 已实现功能

- **协议核心**——`src/protocol/`:帧编解码、校验和、字节流解析(失败重同步)、RX 分派、快照解码、寄存器常量(22 单测)。
- **串口传输**——`src/serial/`:WebSerial 封装(读写/错误/断开)。
- **设备控制器**——`src/device/controller.ts`:会话/初始化/信息、写后回读、写命令串行化、推送节拍统计。
- **仪表页**——连接、实时遥测、状态灯、设 V/A(钳制)、输出开关(确认)、协议日志。
- **记录页**——实时曲线(窗口/暂停/清空)、长时 IndexedDB 会话(采样率/容量上限)、会话 CSV、曲线 PNG/CSV。
- **预设**——M1–M6 编辑/保存/应用;保护——OVP/OCP/OPP/OTP/LVP。
- **扫描页**——电压/电流扫描向导、运行前确认、V-I 图、结果表/CSV。
- **序列页**——(V,A,延时)表格执行器,手动/自动(循环/起止),运行前确认、不打断、异常策略、完成关输出。
- **脚本页**——编辑/检查/运行/停止、样例、保存+导入导出。
- **设置页**——主题/波特率/采样率/容量/确认强度/中断策略;配方管理。
- **存储**——`src/storage/`:localStorage 设置/配方(undo+加载默认)、IndexedDB 会话、CSV 导出。
- **主题**——暗/亮,HP 仪器风;配色参考 [tinysa-webgen](https://git.sr.ht/~bytewolf/tinysa-webgen)(MIT)。

## 设备连接与环境要求

WebSerial 只能访问**浏览器所在操作系统**枚举到的 USB 串口:

- **Windows Chrome/Edge**——若设备被 usbipd 绑定到 WSL,先 `usbipd list` 找到,再 `usbipd attach --wsl --busid <BUSID>`(在 WSL 侧时省略 `--wsl`),然后打开页面→连接→选设备。
- **WSLg 内 Linux Chrome**——设备以 `/dev/ttyACM0` 出现,可先直接连;若 Chrome 枚举不到,用 Windows 侧方案。
- 连接后请先在**低电压/小电流/空载**下验证「仪表→设定→输出」闭环(带确认)。

## 本地串口桥与 WSL 备注

硬件 e2e 套件走本地串口代理(浏览器 WebSerial 路径有已知的 WSL 假死问题)。仅测试用:

```bash
node tools/bridge.cjs 115200 8787            # 串口 -> WebSocket
PROXY=1 node e2e/ui-full.cjs                  # 全 UI 功能验证(真机,headless)
python3 tools/selftest_full.py --run-test     # 设备层全功能验证
```

浏览器手动使用:顶部「连接方式」选 **代理(ws 桥)** 并填 `ws://127.0.0.1:8787`(会记住);USB 直连选 **USB(WebSerial)**。设备权限:拔插后节点常回 root:600,先 `sudo chmod 666 /dev/ttyACM0`。

## 自动化 API

浏览器控制台 `window.dps150` 暴露设备全部能力——连接/断开、设定电压电流(自动钳制+回读)、开关输出、预设 M1–M6、保护阈值、亮度音量、计量、快照刷新、遥测/状态/日志事件订阅。详见 [API.md](API.md) / [English API](../en/API.md)。

## 许可与致谢

- **许可**——[MIT](../../LICENSE)。随附字体(LXGW WenKai)为 SIL Open Font License 1.1;见 `public/fonts/README.txt`。
- **致谢**——[tinysa-webgen](https://git.sr.ht/~bytewolf/tinysa-webgen)(主题,MIT)、[cho45/fnirsi-dps-150](https://github.com/cho45/fnirsi-dps-150)(协议验证,MIT)、[miuser00/fnirst-power-cli](https://github.com/miuser00/fnirst-power-cli)(协议参考,MIT)。
- 使用本项目操作真实负载后果自负(与 CLI/官方类似请自担责任)。
