---
title: "FNIRSI DPS-150 Web Console"
subtitle: "功能概览 · v1.0.0"
date: ""
mainfont: "Droid Sans Fallback"
CJKmainfont: "Droid Sans Fallback"
geometry: "margin=2.4cm"
colorlinks: true
---

# 项目简介

纯前端(Web Serial, Chromium 系浏览器)的 **FNIRSI DPS-150 / DPS-150P** 数控电源上位机。无需安装、无需后端,打开浏览器即可驱动设备。

> **非官方独立项目**,仅供学习与自用。FNIRSI 为深圳市菲尼瑞斯科技有限公司注册商标,与本项目无隶属关系。

---

# 一、实时仪表

连接设备后实时显示**输出电压 / 电流 / 功率 / 温度**,配状态指示灯(输出、CV/CC 模式、保护),并可设定电压/电流(上限钳制)与开关输出(带二次确认)。

![仪表页(暗色,真机数据)](../screens/01-dashboard-dark.png)

![仪表页(English)](../screens/08-dashboard-en.png)

![仪表页(亮色主题)](../screens/02-dashboard-light.png)

# 二、长时记录与实时曲线

实时曲线支持**可调显示窗口**(拖动平移 / 滚轮缩放 / 暂停 / 清空);长时采样使用 **IndexedDB** 会话存储,支持**秒级到一周级**记录(自适应降采样),并提供会话 CSV / 图片导出、曲线 PNG / CSV 导出。

![实时曲线与悬停读数](../screens/07-chart-hover-dark.png)

# 三、预设与保护

**预设 M1–M6**:编辑 / 保存槽位 / 一键应用到主设定,配快速选择面板。

![预设页](../screens/03-presets-dark.png)

**保护阈值**:配置 OVP / OCP / OPP / OTP / LVP;保护触发时状态灯红色报警并给出悬停说明。

![设置页(含保护/配方/国际)](../screens/06-settings-dark.png)

# 四、扫描、序列与脚本

**扫描**:电压 / 电流扫描向导(步进 + 固定轴),运行前确认,输出 V-I 特性图与结果表,支持 CSV 导出。

![扫描页与 V-I 特性图](../screens/04-scan-dark.png)

**DSL 脚本区**:指令式脚本,编辑 / 语法检查 / 运行 / 停止,内置样例,支持保存与导入导出。

![脚本页(DSL)](../screens/05-script-dsl-dark.png)

# 五、自动化 API 与健壮性

**自动化 API**:浏览器控制台可访问 `window.dps150` 完整能力 API —— 连接 / 设定 / 输出 / 预设 / 保护 / 亮度音量 / 计量 / 快照 / 事件订阅。

**健壮性设计**:

- **活动状态机**:连接与自动任务互斥管理,禁止并发任务与运行期手动写,停止采用请求-确认制防死锁。
- **防御式校验**:输入即时校验;序列 / 扫描 / DSL 运行前逐行校验;输出 / 设定二次确认。
- **状态警示**:保护触发 → 状态灯红色快速闪烁 + 高亮 + 悬停说明。

> ⚠️ 真机验证请在**空载 / 低电压 / 小电流限 / 输出关闭**前提下进行;任何输出使能测试需先确认负载与接线安全。
>
> **系统要求**:桌面 Chrome / Edge(Chromium)且支持 [Web Serial](https://developer.chrome.com/articles/serial/),在安全上下文(https 或 localhost)打开。
