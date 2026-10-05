# 定格动画拍摄帧序编排台（gbstopmotion）

面向定格动画的动画师与摄影助理，把镜头拆分、逐帧位移量与拍摄参数记录成可执行的拍摄清单：新建镜头后按帧率与时长自动排帧区间，在帧序条带上插入、删除、移动帧并重算时长，随拍随记曝光参数与实拍张数。帧序、道具区间与实拍记录通过**帧稳定身份（uid）接成可追踪的拍摄批次**：按 180 秒容量分批且同一道具区间不拆开，帧序一改未拍批次立即失效重算，已拍帧与实拍张数继续跟着原帧，原帧消失或离开原道具区间时进入待复核。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21830>

停止（镜像保留）：

```bash
docker compose down
```

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + TypeScript） |
| 构建 | Vite 5 + `vue-tsc -b`（类型检查零错误） |
| 状态 | Pinia（`shotStore` / `frameStore` / `uiStore`） |
| 路由 | Vue Router 4（HTML5 History，nginx `try_files` 兜底） |
| UI | Element Plus + 自研轻量组件 |
| 本地存储 | IndexedDB（Dexie，库名 `gbstopmotion-db`）+ localStorage（表单草稿） |
| 托管 | nginx:alpine（多阶段构建，gzip + 前端路由回落） |

## 目录结构

```
sologsb-1130/
├── docker-compose.yml        # 顶层 name: gbstopmotion，端口 ${FRONTEND_PORT:-21830}
├── .env / .env.example       # COMPOSE_PROJECT_NAME=gbstopmotion
└── frontend/
    ├── Dockerfile            # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf            # try_files $uri $uri/ /index.html + gzip
    ├── public/favicon.svg
    └── src/
        ├── types/{shot,frame,prop,take}.ts        # 4 个数据模型（帧 uid、帧级实拍与复核状态）
        ├── stores/{shotStore,frameStore,uiStore}.ts
        ├── components/common/{FrameStrip,ExposureForm,ShotProgress,StatusTag,EmptyState,BatchPanel,ReviewQueue}.vue
        ├── hooks/{useFrameSequence,useShotBatches,useProgress,useLocalDraft}.ts
        ├── pages/{Overview,ShotNew,ShotDetail,FrameBoard,PropTrack,TakeLog}.vue
        ├── router/index.ts
        ├── utils/{frameMath,batchMath,identity,exposure,format}.ts
        └── db/{index,api}.ts                      # Dexie 实例（v1→v4 升级迁移）与读写层
```

## 页面与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 进度总览 | 各镜头状态、帧数、预计时长、完成百分比，累计全片张数、**拍摄批次容量与待复核数** |
| `/shots/new` | 新建镜头 | 填写镜号、场景名、帧率与时长，保存后生成帧区间与首位帧条目（带稳定 uid） |
| `/shots/:id` | 镜头详情 | 镜头参数与进度、帧序条带、**拍摄批次面板（180 秒分批 / 整批登记实拍）**、待复核队列、帧条目表格、道具轨迹、按日登记实拍 |
| `/frames` | 帧序编排台 | 移动/插入/删除帧、批量套用曝光，改动后重算序号与总时长，**未拍批次即时失效重算（只读批次预览）** |
| `/props` | 道具位移轨迹 | 按镜头与帧区间登记 X/Y/Z 与旋转角度，曲线预览累计位移；区间变化联动批次与复核 |
| `/progress` | 实拍记录 | 登记当日实拍张数与废帧数，回写完成百分比；帧级实拍标记待复核状态 |

## 可追踪拍摄批次

- **稳定身份**：每一帧有终生不变的 `uid`，帧序号 `frameNo` 只表示当前位次；持久化按 uid 差量同步（不再整表删除重建），插入 / 拖动后实拍记录的 `frameUid` 关联不断。
- **180 秒分批**：单帧机时 = 拍摄张数 × 曝光时间，按帧序贪心装满 180 秒；同一道具区间（按帧当前覆盖到的道具区间签名）整体不拆，仅当某区间本身超过 180 秒才强制跨批并标记「道具区间溢出」。
- **失效重算**：批次 id 是成员帧 uid 的哈希。帧序一改，派生视图立即重算——含未拍帧的批次得到新 id（旧批次失效），已拍帧仍凭 uid 跟着原帧、归属可追踪。
- **待复核**：对账（`reconcileTakes`）发现帧级实拍的原帧已删除（孤儿）或帧已离开登记时的道具区间，即置 `reviewStatus='待复核'`；可在镜头详情「确认新归属 / 确认保留」或「弃用」（软删除，不计入张数）。
- **旧数据**：v4 升级为每条帧 / 实拍记录逐帧回填稳定 uid（`legacy-<id>` / `take-legacy-<id>`），旧的按日汇总实拍记录不挂帧、继续参与镜头级进度汇总。

## 数据存储

- **IndexedDB（Dexie，`gbstopmotion-db`）**：镜头、帧条目、道具状态、实拍记录四张表。
  版本迁移：`v1` 建 `shots` / `frames`；`v2` 增加 `props` 表与 `shotId` 索引；`v3` 增加 `takes` 表并按实拍张数回填进度；`v4` 为帧与实拍记录逐帧回填稳定身份 `uid`（`frames.uid`、`takes.frameUid` 索引），实拍记录增加复核状态与软删除标记，支撑可追踪拍摄批次。
- **localStorage**：新建镜头表单与批量曝光参数草稿，键前缀 `gbstopmotion:draft:`。
- 全部数据存在浏览器本地，容器无状态、不使用数据库服务、不挂载命名卷，无任何后端接口调用。
