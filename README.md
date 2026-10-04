# 工业过程数字孪生与异常根因推理服务

纯后端 Node.js + TypeScript + Fastify 服务，默认无需 Docker、数据库或消息中间件即可运行。

## 启动

```bash
npm install
npm run dev
```

默认端口：`6301`。健康检查：`GET /health`。

## 业务闭环

- 领域状态模型与事件输入
- 可回放的时间序列/仿真流程
- 约束校验与风险门禁
- 方案版本、审计轨迹与异常处置
- 所有状态暂存于进程内，便于本机演示；可扩展为数据库、事件总线和实时流处理架构

## 增强业务闭环

- 配方版本、工艺窗口风险评估与审批
- What-if 工况推演，输出吞吐量、质量、能耗和风险
- 受控闭环控制命令，受操作窗口和高严重度异常门禁约束
- 控制执行账本：租约/派发/确认/失败/过期/撤销，幂等收敛与证据时间线
- HTTP 模拟执行器回调，无需消息中间件
- 维修窗口、备件准备、下游影响与 LOTO 锁定确认
- 综合过程健康评分

扩展接口：`/api/recipes`、`/api/control/commands`、`/api/control/ledger`、`/api/executor/simulate`、`/api/maintenance/windows`、`/api/process/health-score`。

## 控制执行账本

- 命令被接受时自动创建租约（`leased`），随后 `dispatch → confirmed/failed`；超时未确认懒结算为 `expired`，也可 `revoke` 撤销，终态不可逆
- 派发/确认/失败分别凭 `dispatchKey`/`confirmKey`/`failureKey` 幂等收敛：同键重放原结果，异键 409；命令创建支持可选 `idempotencyKey`
- 过期或撤销后的迟到确认只记入时间线（`confirm.late`）并返回 409，不会恢复命令；撤销/失败只追加事件，门禁快照与时间线证据完整保留
- 查询：`GET /api/control/commands`、`GET /api/control/commands/:id`（含 `execution` 最终状态）、`GET /api/control/ledger/:commandId`（完整时间线）、`POST /api/control/ledger/sweep`（批量结算过期）
- `POST /api/executor/simulate` 以纯 HTTP 回调模拟现场执行器，`behavior` 支持 `confirm`、`duplicate-dispatch`、`duplicate-confirm`、`fail`、`late-confirm`
