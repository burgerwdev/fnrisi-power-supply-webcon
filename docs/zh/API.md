# DPS-150 Web 控制台 —— 自动化 API 指南

> **English API:** [docs/en/API.md](../en/API.md)

> 本项目为**纯前端**实现(Web Serial,Chromium 系浏览器)。除图形界面外,我们还把设备的**全部能力**暴露为浏览器内的 JavaScript API,便于你在开发者工具控制台、书签脚本或"高级模式·脚本区"中自动化操作。

## 入口

打开页面后,`window.dps150` 即就绪:

```js
dps150;                 // 查看对象(带方法文档)
dps150.state;           // 当前设备状态快照(实时只读)
```

> 说明:自动化运行在**你当前浏览器会话**中,与页面 UI 共享同一设备连接与状态,天然一致、无竞态;写命令由控制器串行化。

## 快速上手(控制台示例)

```js
// 1. 连接(弹出系统设备选择框,选 DPS-150)
await dps150.connect();

// 2. 读当前状态(设置/实测/保护/上限…)
dps150.state.settings.voltageSet;   // 当前电压设定
dps150.state.limits.maxVoltage;     // 电压上限(≈输入电压-0.2)

// 3. 设电压/电流(会自动按上限钳制并回读)
await dps150.setVoltage(12.0);
await dps150.setCurrent(1.0);

// 4. 开/关输出(请先确认负载安全!)
await dps150.enableOutput();
await dps150.disableOutput();

// 5. 订阅遥测,打印 3 秒
const off = dps150.onTelemetry((s) => console.log(s.telemetry.vout, s.telemetry.iout));
setTimeout(off, 3000);

// 6. 断开
await dps150.disconnect();
```

## 常用方法与约定

| 方法 | 说明 |
|---|---|
| `connect()` / `disconnect()` | 连接(系统选端口)/ 断开(先发会话关闭,再关串口) |
| `setVoltage(v)` / `setCurrent(a)` | 设定电压(V)/ 电流限(A);超出上限自动钳制;写后回读 FF 快照 |
| `enableOutput()` / `disableOutput()` / `setOutput(run)` | 输出 RUN / STOP(⚠ 危险操作,请在脚本内自行确认负载安全) |
| `setPreset(n, v, a)` | 写预设槽 M1–M6(不改主设定) |
| `loadPreset(n)` | 加载预设:写槽 + 镜像到主设定(官方行为) |
| `setProtection(kind, value)` | kind ∈ `ovp|ocp|opp|otp|lvp`(写保护阈值并回读) |
| `setBrightness(v)` / `setVolume(v)` | 亮度 / 音量(设备支持,实测可用) |
| `setMetering(on)` | 计量开关(D8);开启且输出 RUN 时设备每周期推送 D9/DA |
| `refresh()` | 主动拉取 FF 全量快照并刷新 `state` |
| `state`(属性) | `DeviceState`:`info / telemetry / status / limits / settings / presets / protections / telemetryPeriodMs` |
| `onTelemetry(cb)` `onState(cb)` `onLog(cb)` | 事件订阅,返回退订函数;`cb(state)` 每帧/每状态更新触发 |

状态字段速览(与协议文档一致):

```js
state.info            // { modelName:"DPS-150P", hwVersion:"V1.0", fwVersion:"V1.6", ident:1 }
state.telemetry       // { inputVoltage, outputVoltage, outputCurrent, outputPower, temperature, capacityAh, energyWh, ts }
state.status          // { output:"RUN"|"STOP", protection:"OK"|"OVP"|"OCP"|"OPP"|"OTP"|"LVP", mode:"CC"|"CV" }
state.limits          // { maxVoltage, maxCurrent }   (由设备推送 E2/E3)
state.settings        // { voltageSet, currentSet, brightness, volume, meteringOn }
state.presets         // [{voltage,current}×6]  M1..M6
state.protections     // { ovp, ocp, opp, otp, lvp }
```

## 脚本示例(可在控制台直接试)

```js
// 例1:安全地跑一个"低电压冒烟序列"(输出关闭状态下写设定)
(async () => {
  if (!dps150.connected) await dps150.connect();
  await dps150.setVoltage(1.0);
  await dps150.setCurrent(0.05);
  console.log('ready at 1.0V/50mA');
})();

// 例2:订阅并把遥测累计 10 秒,算出均值
(async () => {
  if (!dps150.connected) await dps150.connect();
  let n = 0, sum = 0;
  const off = dps150.onTelemetry(s => { sum += s.telemetry.vout || 0; n++; });
  await new Promise(r => setTimeout(r, 10000));
  off();
  console.log(`avg vout = ${(sum / n).toFixed(3)} V (${n} samples)`);
})();

// 例3:写一组保护并恢复(输出关闭状态安全)
await dps150.setProtection('ovp', 25);
await dps150.setProtection('ovp', dps150.state.protections.ovp); // 恢复原值
```

## 注意事项

- **危险操作确认**:图形界面对开启输出等敏感操作有确认弹窗;脚本方式请自行加确认逻辑(如先 `console.log` 警示再执行)。示例建议始终在**低电压 + 小电流限 + 确认空载/负载安全**下进行。
- 协议参考社区公开资料实现;真实行为以设备实测为准(准确性不保证)。
- 自动化受浏览器页面生命周期约束:刷新/关闭即断开(控制器会自动做会话关闭清理)。超长时间无人值守请保持页面常开(可考虑浏览器后台节流设置)。
