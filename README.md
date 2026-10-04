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
- 维修窗口、备件准备、下游影响与 LOTO 锁定确认
- 综合过程健康评分

扩展接口：`/api/recipes`、`/api/control/commands`、`/api/maintenance/windows`、`/api/process/health-score`。

## 控制执行账本

`POST /api/control/commands` 保持原有创建接口兼容：成功响应仍包含原有的 `accepted` 初始状态与 `risk` 字段，同时在进程内建立同名控制账本。账本保存门禁结果、租约、派发表征、确认/失败/撤销原始证据和不可变审计时间线。

状态流转：

```text
accepted -> leased -> dispatched -> confirmed
                    ├-> failed
accepted/leased/dispatched -> revoked
任意非终态 -> expired
```

终态为 `confirmed`、`failed`、`expired`、`revoked`。到达终态后，迟到确认不会恢复命令；失败或撤销也不能覆盖已有终态证据。

### 账本接口

所有幂等标识均可放在请求体 `idempotencyKey` 或 HTTP 头 `Idempotency-Key` 中。

- `GET /api/control/commands`：列出命令；返回中的 `status`、`finalStatus` 与 `ledger.status` 反映当前/最终状态，支持 `?status=` 过滤。
- `GET /api/control/commands/:id`：查询单条命令、门禁结果、租约、派发、确认、失败、撤销及完整 `ledger.timeline`。
- `POST /api/control/ledger/commands/:id/lease`：创建执行租约；租约沿用命令 TTL，防止超过原始控制窗口。
- `POST /api/control/ledger/commands/:id/dispatch`：通过 HTTP 调模拟执行器，`idempotencyKey` 必填；同一标识重复派发返回同一结果，不同标识在已派发/终态时返回 `409`。
- `POST /api/control/ledger/commands/:id/confirm`：确认执行，`idempotencyKey` 必填；重复确认收敛，`expired` 等终态后的迟到确认返回 `409` 且只记录拒绝时间线。
- `POST /api/control/ledger/commands/:id/fail`：执行失败，`idempotencyKey` 和 `reason` 必填；失败证据独立保存，不能覆盖确认、撤销或过期结果。
- `POST /api/control/ledger/commands/:id/expire`：按 `expiresAt` 执行过期检查；读取单条/列表命令时也会惰性过期。
- `POST /api/control/ledger/commands/:id/revoke`：撤销非终态命令，`reason` 必填；撤销后原始派发/失败证据仍保留在账本中。
- `GET /api/audit`：保留全局审计日志，账本状态转换会追加 `control-command.*` 事件。

### HTTP 模拟执行器

服务内置仅基于 HTTP 的执行器，不使用消息中间件：

- `POST /api/executor-simulator/deliveries`：账本派发时自动调用。
- `GET /api/executor-simulator/deliveries/:id`：查看执行器收到的派发和报告历史。
- `POST /api/executor-simulator/deliveries/:id/report`：执行器回调账本，请求体示例：`{ "idempotencyKey": "ack-1", "status": "confirmed", "result": {"applied": true}, "evidence": {"sensor": "ok"} }`；失败回执使用 `status: "failed"`、`reason` 和可选 `code`。

最小流程：

```bash
curl -s -X POST http://127.0.0.1:6301/api/control/commands \
  -H 'content-type: application/json' \
  -d '{"assetId":"reactor-01","parameters":{"temperature":75,"pressure":2.7,"flow":108},"ttlSeconds":60}'

curl -s -X POST http://127.0.0.1:6301/api/control/ledger/commands/<commandId>/lease \
  -H 'content-type: application/json' -d '{}'

curl -s -X POST http://127.0.0.1:6301/api/control/ledger/commands/<commandId>/dispatch \
  -H 'content-type: application/json' -d '{"idempotencyKey":"dispatch-1"}'

curl -s -X POST http://127.0.0.1:6301/api/executor-simulator/deliveries/<deliveryId>/report \
  -H 'content-type: application/json' \
  -d '{"idempotencyKey":"confirm-1","status":"confirmed","result":{"applied":true}}'
```
