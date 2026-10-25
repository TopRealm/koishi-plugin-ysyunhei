# koishi-plugin-ysyunhei

[![npm](https://img.shields.io/npm/v/koishi-plugin-ysyunhei?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-ysyunhei)

## 介绍

通过 Koishi 实现对 [有兽焉云黑系统](https://yunhei.youshou.wiki/#/) 添加和查询人员的机器人插件。

**同时支持 OneBot 适配器与 QQ 官方机器人适配器**，设置时二选一即可。在OneBot适配器下能完整运行，在QQ官方适配器下则有一定限制（详情见下）。

## 安装与配置

推荐使用 yarn 安装本插件：

```bash
yarn add koishi-plugin-ysyunhei
```

> 本项目已全面采用 yarn 作为包管理器，不再推荐使用 npm。

### 配置项

- `api_key`：你在云黑系统中的 API Key。
- `admin_qqs`：管理员 ID → “登记人昵称”的映射。
  - OneBot 下：key 为 QQ 号，调用 `yunhei.add` 时用配置的昵称上报云黑
  - QQ 官方群聊下：调用者权限改用 `member_role`（群主/管理员自动放行），不依赖此白名单；未配置时登记人昵称回退为发送者昵称或“群管理员”
- `sleep_start_hour`：精致睡眠开始时间（北京时间整点，0-23，默认 22）。
- `sleep_end_hour`：精致睡眠结束时间（北京时间整点，0-23，默认 2）。
- `sleep_mute_hours`：精致睡眠禁言时长（小时，1-24，默认 8）。
- `render_as_image`：是否将主要文本输出渲染为图片消息（默认关闭）。开启后若系统安装了 `@koishijs/plugin-puppeteer`，插件会把 `yunhei.add` / `yunhei.chk`（单人查询）/ `yunhei.about` 的输出以卡片图片形式发送；若未安装或渲染失败，会自动回退为纯文本。
- `render_service_preference`：图片渲染服务偏好，取值：
	- `auto`（默认）：优先使用 Puppeteer，失败回退 Canvas；都不可用则回退文本。
	- `puppeteer`：仅使用 Puppeteer（不可用则回退文本）。
	- `canvas`：仅使用 Canvas（不可用则回退文本）。

> 禁言、撤回、入群审批等操作均需要机器人在群内为管理员及以上权限。

## 指令列表

### 在云黑中添加账号

`yunhei.add <qqnum> <level> <desc> [bantime]`

将指定的账号添加到云黑中。

- `qqnum`:需要添加的QQ号
- `level`:违规严重程度，取值1/2/3，分别对应轻微、中等、严重。在达到“严重”等级后，云黑会自动将该账号从所在的群里踢出，并自动拒绝该账号加入群聊。（踢群功能在QQ官方适配器下暂时无法使用）
- `desc`:违规描述，用于记录违规行为。
- `bantime`:禁言时长（可选）。当该项有值，机器人会给该账号设置所在的群里指定的禁言时长。（QQ官方适配器下需配合快速禁言使用）

补充说明：

- 登记人昵称优先取 `admin_qqs` 配置；QQ 官方群聊下未配置时回退为发送者昵称或“群管理员”。
- 依据等级设置处理时长：`level=1` 记录时长一年；`level>=2` 为永久。
- 可选参数 `bantime` 的写法支持中文单位组合：`天`、`小时/时`、`分钟/分`。例如：`1天2小时30分`、`45分`、`2小时`。
- 需要机器人为群管理员或以上，且调用者必须在 `admin_qqs` 列表内。

### 在云黑中查询账号

`yunhei.chk [qqnum]`（别名：`yunhei.cx`）

当填写了 `qqnum` 时，机器人会查询该账号是否在云黑中，如果有则给出相应信息。

补充说明：

- 未提供 `qqnum` 时会尝试检查群内的所有成员（需要适配器支持 `getGuildMemberList`）。
- OneBot 下：可整群扫描；检测到“严重”账号的提示需手动处理（已移除自动踢出）。
- QQ 官方群聊下：不支持枚举群成员，将提示“请改为查询单个用户”。
- 单用户查询时若查不到陌生人昵称，QQ 官方群聊下回退显示 QQ 号。

### 快速禁言

`yunhei.ban <target> <duration>`（别名：`yunhei.b`）

通过 @群内成员直接禁言目标用户。

- 用法示例：`yunhei ban @用户 1天2小时`
- 时长格式与 `yunhei.add` 的 `bantime` 一致（天/小时/分钟）。
- `target` 解析优先级：koishi 解析的 @ 元素 → QQ 官方事件原始 `mentions` 字段 → 直接传 openid 字符串兜底。
- **主要面向 QQ 官方机器人场景**：QQ 官方 v2 群聊里 `session.userId` 是 openid，不能按 QQ 号禁言；通过 @mention 可拿到目标在群内的 member_openid 后调禁言接口。
- OneBot 下也可用，但通常 `yunhei.add <qq> <level> <desc> <bantime>` 已经够用。
- 限制：仅群聊可用；需要机器人是群管理员。

### 查看插件信息

`yunhei.about`

显示当前插件版本、贡献者列表，并检查云黑官网可用性。

### 趣味：精致睡眠

`yunhei.sleepwell [confirm]`

- 作用：在北京时间 `sleep_start_hour` 至 `sleep_end_hour` 期间，对自己执行 `sleep_mute_hours` 小时禁言（默认 22:00-02:00，禁言 8 小时）。
- 使用：在时间段内，直接输入 `yunhei.sleepwell` 会提示确认信息，输入 `yunhei.sleepwell confirm` 即执行。
- 限制：仅群聊可用；非上述时间段调用将不会有任何输出；需要机器人为群管理员或以上；若执行者为群主/管理员，将不会执行禁言。

## 使用限制与冷却

- **权限规则**：
  - **OneBot**：调用 `yunhei.add` / `yunhei.chk` 需在 `admin_qqs` 白名单内；`yunhei.ban` / `yunhei.sleepwell` 需调用者为群主/管理员或机器人本身具备群管权限。
  - **QQ 官方群聊**：`yunhei.add` / `yunhei.chk` / `yunhei.ban` 调用者权限按 `member_role` 判定（群主/管理员自动放行，普通成员拒绝）。
- **场景**：`yunhei.add` / `yunhei.chk` / `yunhei.ban` / `yunhei.sleepwell` 仅群聊可用。
- **冷却**：为避免刷屏，单个用户对于同一指令存在 30 秒冷却时间。
- 禁言/撤回/入群审批等操作均需要机器人在群内为管理员及以上权限。

## 许可

本项目以 MIT 协议发布。详见仓库根目录的 LICENSE 文件。
