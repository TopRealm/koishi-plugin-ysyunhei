// SPDX-License-Identifier: MIT
import { Context, Schema, Session, h, segment } from 'koishi'

import checkAndSetCooldown from './utils/check-and-set-cooldown'
import hitSleepwellDebounce from './utils/hit-sleepwell-debounce'
import maybeRenderAsImage from './utils/maybe-render-asImage'
import {
  getPlatform,
  getCapabilities,
  describeUnsupported,
  getMemberInfo,
  muteMember,
  isManager,
} from './utils/platform'
import { applyQQBotGroupPatch } from './utils/qq-patch'

// 实现的指令导入
import about from './command/ys-about'
import add from './command/ys-add'
import ban from './command/ys-ban'
import check from './command/ys-check'

import type Config from './config'

export const name = 'ysyunhei'

// 声明可选注入的服务，避免访问未注册属性的告警 弃用
// export const inject = { optional: ['puppeteer', 'canvas'] as const }

// 控制台展示用使用说明（遵循官方插件的写法）
export const usage = `
## 指令列表
以下内容在OneBot适配器下能完整运行，在QQ官方适配器下则有一定限制（详情见下）。
### 在云黑中添加账号
\`yunhei.add <qqnum> <level> <desc> [bantime]\`

将指定的账号添加到云黑中。
* \`qqnum\`:需要添加的QQ号
* \`level\`:违规严重程度，取值1/2/3，分别对应轻微、中等、严重。在达到“严重”等级后，云黑会自动将该账号从所在的群里踢出，并自动拒绝该账号加入群聊。（踢群功能在QQ官方适配器下暂时无法使用）
* \`desc\`:违规描述，用于记录违规行为。
* \`bantime\`:禁言时长（可选）。当该项有值，机器人会给该账号设置所在的群里指定的禁言时长。（QQ官方适配器下需配合快速禁言使用）
### 在云黑中查询账号
\`yunhei.chk [qqnum]\`（别名：\`yunhei.cx\`）

当填写了\`qqnum\`时，机器人会查询该账号是否在云黑中，如果有则给出相应信息。如果没有给\`qqnum\`填写值，则会查询群内的所有成员（包括管理员与群主）。在执行后一种检查操作时，如果存在等级为“严重”的账号，机器人同样会将该账号从所在的群里踢出。
\n### 快速禁言\n\`yunhei.ban @用户 <时长>\`（别名：\`yunhei.b\`）\n\n- 作用：通过 @ 群内成员的方式直接禁言目标用户。主要面向 QQ 官方机器人场景：QQ 官方机器人按 QQ 号禁言不可行，但通过 @mention 可拿到目标在群内的 openid 进行禁言。\n- 用法：\`yunhei ban @用户 1天2小时\`，时长支持 \`天/小时/分钟\` 单位组合。\n- 限制：仅群聊可用；需要机器人具有群管理员权限。\n### 查看插件信息\n\`yunhei.about\`\n\n显示当前插件版本、贡献者列表，并检查云黑官网可用性。
\n### 趣味：精致睡眠\n\`yunhei.sleepwell [confirm]\`\n\n- 作用：在北京时间 22:00-02:00 期间，对自己执行 8 小时禁言。\n- 使用：在时间段内，直接输入 \`yunhei.sleepwell\` 会提示确认信息，输入 \`yunhei.sleepwell confirm\` 即执行。\n- 限制：仅群聊可用；非上述时间段调用将不会有任何输出。
`

export const Config: Schema<Config> = Schema.object({
  api_key: Schema.string().role('secret').description('你在云黑系统中的API Key。').required(),
  admin_qqs: Schema.dict(Schema.string()).description('管理员 QQ 到“登记人昵称”的映射。只有键中包含的 QQ 能使用全部功能；登记时会用其对应的昵称作为登记人上报云黑。').default({}),
  sleep_start_hour: Schema.number().min(0).max(23).default(22).description('精致睡眠开始时间（北京时间小时，0-23）。'),
  sleep_end_hour: Schema.number().min(0).max(23).default(2).description('精致睡眠结束时间（北京时间小时，0-23）。'),
  sleep_mute_hours: Schema.number().min(1).max(24).default(8).description('精致睡眠禁言时长（小时）。'),
  render_as_image: Schema.boolean().default(false).description('将主要输出（如查询/添加结果、about）渲染为图片消息。'),
  render_service_preference: Schema.union([
    Schema.const('auto').description('自动（优先使用 Puppeteer，失败回退 Canvas）'),
    Schema.const('puppeteer').description('仅使用 Puppeteer（不可用则回退为文本）'),
    Schema.const('canvas').description('仅使用 Canvas（不可用则回退为文本）'),
  ]).default('auto').description('图片渲染服务偏好。'),
  browser_path: Schema.string().role('secret').description('浏览器路径（仅 Puppeteer 渲染时有效）。').default(''),
  theme_date: Schema.string().role('secret').default('8/20').description('主题自动切换时间。在这个时间段为白色主题，使用/分割时间段。'),
  theme_color: Schema.string().role('secret').default('#e8edf2/#252525').description('主题颜色。'),
})

export function apply(ctx: Context, config: Config) {
  // 应用 QQ 官方机器人·群聊场景能力补丁（在 @koishijs/plugin-adapter-qq 已安装时生效）
  applyQQBotGroupPatch(ctx)
  ctx.command('yunhei.add <qqnum> <level:number> <desc> [bantime]')
    .action(async ({ session }, qqnum, level, desc, bantime) => {
      const tip = checkAndSetCooldown(session, 'yunhei.add')
      if (tip) return tip
      const res = await add(ctx, session, qqnum, level, desc, bantime, config)
      return maybeRenderAsImage(ctx, config, res, { title: '云黑添加结果' })
    })
  ctx.command('yunhei.chk [qqnum]')
    .alias('yunhei.cx')
    .action(async ({ session }, qqnum) => {
      const tip = checkAndSetCooldown(session, 'yunhei.chk')
      if (tip) return tip
      const res = await check(ctx, session, qqnum, config)
      // 当检查整个群时，函数内部会主动分批发送并返回 void，此时不做图片渲染
      if (res == null) return
      return maybeRenderAsImage(ctx, config, res, { title: '云黑查询结果' })
    })
  ctx.command('yunhei.ban <target> <duration:string>')
    .alias('yunhei.b')
    .action(async ({ session }, target, duration) => {
      const tip = checkAndSetCooldown(session, 'yunhei.ban')
      if (tip) return tip
      const res = await ban(ctx, session, target, duration, config)
      return maybeRenderAsImage(ctx, config, res, { title: '快速禁言结果' })
    })
  ctx.command('yunhei.about')
    .action(async ({ session }) => {
      const tip = checkAndSetCooldown(session, 'yunhei.about')
      if (tip) return tip
      const res = await about()
      return maybeRenderAsImage(ctx, config, res, { title: '关于本插件' })
    })

  ctx.command('yunhei.sleepwell [confirm]')
    .action(async ({ session }, confirm) => {
      // 仅群聊可用；若不是群聊则静默
      if (!session.guildId) return
      // 获取北京时间（UTC+8）
      const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
      const hour = now.getUTCHours()
      // 精致睡眠区间（来自配置；默认 22-02）
      const start = Math.max(0, Math.min(23, (config.sleep_start_hour ?? 22) | 0))
      const end = Math.max(0, Math.min(23, (config.sleep_end_hour ?? 2) | 0))
      const inSleepTime = start === end
        ? true
        : (start < end ? (hour >= start && hour < end) : (hour >= start || hour < end))
      if (!inSleepTime) {
        // 不在时间段则完全不响应
        return
      }
      // 能力检测：当前适配器必须支持禁言
      const caps = getCapabilities(session)
      if (!caps.mute) {
        // QQ 官方群等不支持禁言平台：换成温和提示，不直接拒绝
        return `当前平台（${session.platform}）不支持禁言操作，无法为你执行精致睡眠。请注意休息哦~`
      }

      // 检测调用者在群内的角色（群主/管理员 拒绝；普通成员 才执行禁言）
      // QQ 官方群：读 koishi 适配器解析的 session.event.member.member_role
      // OneBot/频道：调 getMemberInfo 查群成员角色
      let isGroupManager = false
      try {
        if (getPlatform(session) === 'qq') {
          // QQ 官方群：member 已由 koishi 适配器写入 session.event.member
          isGroupManager = isManager((session as any).event?.member ?? (session as any).member)
        } else {
          // OneBot / 频道：satori 统一 API 查群成员
          const info = await getMemberInfo(session, session.guildId, session.userId)
          isGroupManager = !!info?.isManager
        }
      } catch {
        // 查不到角色信息 → 保守按"非群管"处理，让 muteMember 失败时兜底
        isGroupManager = false
      }
      if (isGroupManager) {
        return '你已经是一个成熟的群管了，要学会以身作则按时休息！'
      }

      const muteHours = Math.max(1, ((config.sleep_mute_hours ?? 8) | 0))
      const baseMsg = `本命令将会针对执行一个${muteHours}小时的禁言，正所谓精致睡眠。`
      if (!confirm) {
        return `${baseMsg}\n\n当前已在精致睡眠时间段（${start}:00-${end}:00），如果确认，请输入以下命令。注意，此操作不可撤销！\n*yunhei.sleepwell confirm`
      }
      if (String(confirm).toLowerCase() === 'confirm') {
        // 轻量防抖：2 秒内重复 confirm 将被拒绝
        if (hitSleepwellDebounce(session)) {
          return '操作过于频繁，请稍后再试。'
        }
        try {
          const seconds = muteHours * 60 * 60
          await muteMember(session, session.guildId, session.userId, seconds)
          return `${muteHours}小时精致睡眠已到账，晚安~`
        } catch (e: any) {
          // 识别 QQ 官方 API 错误码，给出针对性提示
          const qqCode = (e as any)?.qqErrCode
          if (qqCode === 40011030) {
            return '禁言失败：当前机器人不是群管理员。请联系群主把机器人设为群管理员后重试。'
          }
          return '禁言失败，可能是机器人权限不足或当前平台不支持禁言。'
        }
      }
      return
    })
}
