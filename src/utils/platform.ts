import type { Session, Universal } from 'koishi'

export type Platform = 'onebot' | 'qq' | 'qqguild' | 'other'

export function getPlatform(session: Session): Platform {
  const p = session.platform
  if (p === 'onebot') return 'onebot'
  if (p === 'qq') return 'qq'
  if (p === 'qqguild') return 'qqguild'
  return 'other'
}

type MinimalMember = { roles?: Array<{ id?: string | number }> | null }

// —— 角色判定 ——
// onebot: roles[0].id ∈ {owner, admin, member}
// qq 官方群: member.roles[0].id ∈ {owner, admin, member}（来自 GROUP_* 事件 author.member_role）
// qqguild: 身份组 id 数字串：2=管理员，4=群主，5=子频道管理员
const MANAGER_ROLE_IDS = new Set<string | number>(['owner', 'admin', 2, 4, 5, '2', '4', '5'])

export function isManager(member: MinimalMember | null | undefined): boolean {
  if (!member?.roles?.length) return false
  return member.roles.some(r => {
    if (!r) return false
    const id = r.id
    if (id == null) return false
    return MANAGER_ROLE_IDS.has(id) || MANAGER_ROLE_IDS.has(String(id))
  })
}

// —— 调用者（指令发起人）权限判定 ——
// 策略：
// 1) QQ 官方群（platform='qq'）：从 session.member.roles[0].id 读 member_role，
//    koishi 适配器已把 GROUP_* 事件 author.member_role 自动写入此处。
//    member_role ∈ {admin, owner} → 放行；否则拒绝。
//    （QQ 官方群下 session.userId 是 openid，难维护白名单，所以按角色放行）
// 2) 其它适配器（onebot 等）：走 config.admin_qqs 白名单（向后兼容）
export interface CallerManagerConfig {
  admin_qqs?: Record<string, string> | null
}

export function isCallerManager(
  session: Session,
  config: CallerManagerConfig,
): { ok: boolean; reason?: string } {
  const platform = getPlatform(session)
  if (platform === 'qq') {
    // QQ 官方群：按 member_role 判定
    // koishi 适配器把 GROUP_* 事件 author.member_role 写入 session.event.member.roles[0].id
    // （见 @satorijs/adapter-qq/lib/index.cjs#L400 解析逻辑）
    const member = (session as any).event?.member ?? (session as any).member
    if (isManager(member)) {
      return { ok: true }
    }
    return { ok: false, reason: 'qq-official-group: 消息发送者非群主/管理员' }
  }
  // OneBot / 其它适配器：走 admin_qqs 白名单
  if (!config.admin_qqs || !(session.userId in config.admin_qqs)) {
    return { ok: false, reason: 'not in admin_qqs whitelist' }
  }
  return { ok: true }
}

// —— 能力检测 ——
export interface Capabilities {
  /** 获取群成员信息 */
  getMember: boolean
  /** 获取群成员列表 */
  listMembers: boolean
  /** 踢人 */
  kick: boolean
  /** 禁言 */
  mute: boolean
  /** 通过 userId 获取用户昵称（陌生人） */
  strangerNickname: boolean
}

export function getCapabilities(session: Session): Capabilities {
  // 纯能力检测：直接看 session.bot 上是否实现了 satori 统一 Bot API 的对应方法。
  // - onebot 适配器（OneBotBot）实现了 getGuildMember/kickGuildMember/muteGuildMember/...，返回 true
  // - qq 官方群适配器（QQBot, platform='qq'）未暴露这些群管理方法，自然返回 false
  // - qqguild 适配器（QQGuildBot, platform='qqguild'）实现了这些方法，返回 true
  // 这种写法不绑定具体平台名，对未来出现的适配器也自动适用。
  const bot: any = session.bot
  return {
    getMember: typeof bot?.getGuildMember === 'function',
    listMembers: typeof bot?.getGuildMemberList === 'function',
    kick: typeof bot?.kickGuildMember === 'function',
    mute: typeof bot?.muteGuildMember === 'function',
    strangerNickname: typeof bot?.getUser === 'function',
  }
}

export type Action = keyof Capabilities

export function describeUnsupported(cap: Action): string {
  switch (cap) {
    case 'getMember': return '当前适配器不支持查询群成员信息'
    case 'listMembers': return '当前适配器不支持枚举群成员列表'
    case 'kick': return '当前适配器不支持踢出群成员'
    case 'mute': return '当前适配器不支持设置禁言'
    case 'strangerNickname': return '当前适配器不支持按账号查询昵称'
  }
}

// —— 获取群成员信息 ——
export interface MemberInfo {
  user_id: string
  nickname: string
  /** 是否为群主/管理员/子频道管理员 */
  isManager: boolean
  /** 是否为普通成员（非管理、非群主）；若角色信息缺失，则为 false（不确定） */
  isOrdinaryMember: boolean
  /** 原始 member 对象 */
  raw?: Universal.GuildMember
}

/**
 * 获取指定成员信息。
 * 若适配器不支持，但目标是消息发送者且 session 里有 member 上下文，则回退用 session 数据。
 */
export async function getMemberInfo(session: Session, guildId: string, userId: string): Promise<MemberInfo | null> {
  const cap = getCapabilities(session)
  let raw: Universal.GuildMember | null = null

  if (cap.getMember && session.bot?.getGuildMember) {
    try {
      raw = await session.bot.getGuildMember(guildId, userId) as Universal.GuildMember
    } catch {
      raw = null
    }
  }

  // 回退：当前消息发送者
  if (!raw && userId === session.userId) {
    const sesMember = (session as any).member as Universal.GuildMember | undefined
    if (sesMember) raw = sesMember
  }
  // 回退：极少数情况下 session 自身即机器人（selfId === userId）
  if (!raw && userId === session.selfId && userId === session.userId) {
    const sesMember = (session as any).member as Universal.GuildMember | undefined
    if (sesMember) raw = sesMember
  }

  if (!raw) return null

  const userObj: Universal.User | undefined = (raw as any).user
  const rawNick = (raw as any).nick
  const rawName = raw.name
  const userName = userObj?.name
  const userNick = (userObj as any)?.nick
  const nickname: string = String(rawNick ?? rawName ?? userName ?? userNick ?? userId)

  const manager = isManager(raw as any)
  const hasRoleInfo = !!(raw as any).roles?.length

  return {
    user_id: userObj?.id ? String(userObj.id) : userId,
    nickname,
    isManager: manager,
    // 仅有当角色列表存在且不包含管理角色时，才能判定为"普通成员"
    isOrdinaryMember: hasRoleInfo && !manager,
    raw,
  }
}

/**
 * 检查机器人自身是否具有群管理权限（或至少非普通成员）。
 *
 * 策略：
 * 1) 若适配器支持 getMember：直接查机器人自身角色
 * 2) 否则（如 qq 官方群）：无法直接查询机器人角色；保守放行，等真正执行踢/禁言时再抛错
 */
export async function isSelfManager(session: Session): Promise<{ ok: boolean; reason?: string }> {
  const platform = getPlatform(session)

  // QQ 官方群（platform='qq'）：
  //   不做机器人管理员预检查，让真实 API 调用（如 muteGuildMember）作为最终判断。
  //   原因：QQ 官方机器人入群时可能未通过群主授权管理员身份，
  //   即便非管理员，调禁言/撤回等接口时平台会返回明确的错误码，
  //   ysyunhei 已对实际 API 调用做了 try/catch 兜底，无需前置拦截。
  if (platform === 'qq') {
    return { ok: true, reason: 'qq-official-group: skip manager pre-check' }
  }

  const info = await getMemberInfo(session, session.guildId!, session.selfId)
  if (!info) {
    return { ok: false, reason: '无法查询机器人自身角色信息' }
  }
  if (!info.isManager && info.isOrdinaryMember) {
    return { ok: false, reason: '机器人非管理员' }
  }
  return { ok: true }
}

// —— 批量获取群成员列表 ——
export interface ListMembersResult {
  members: MemberInfo[]
  /** 是否部分结果（例如遇到了错误或分页未完成） */
  partial: boolean
}

export async function listAllMembers(session: Session, guildId: string): Promise<ListMembersResult> {
  const cap = getCapabilities(session)
  const out: MemberInfo[] = []
  if (!cap.listMembers || !session.bot?.getGuildMemberList) {
    return { members: [], partial: false }
  }
  try {
    const platform = getPlatform(session)
    // onebot 没有分页 token；qqguild 提供分页
    if (platform === 'onebot') {
      const res = await session.bot.getGuildMemberList(guildId)
      for (const m of res.data ?? []) {
        out.push(castRawMember(m))
      }
      return { members: out, partial: false }
    }
    // 通用分页路径
    let next: string | undefined
    for (let i = 0; i < 100; i++) {
      const res = await session.bot.getGuildMemberList(guildId, next)
      for (const m of res.data ?? []) {
        out.push(castRawMember(m))
      }
      next = (res as any).next
      if (!next) break
    }
    return { members: out, partial: !!next }
  } catch {
    return { members: out, partial: true }
  }
}

function castRawMember(m: Universal.GuildMember): MemberInfo {
  const raw = m as any
  const userObj = raw.user
  const uid = userObj?.id ?? raw.user_id ?? ''
  const nickname = String(raw.nick ?? raw.name ?? userObj?.name ?? userObj?.nick ?? uid)
  const manager = isManager(raw)
  const hasRoleInfo = !!raw.roles?.length
  return {
    user_id: uid ? String(uid) : '',
    nickname,
    isManager: manager,
    isOrdinaryMember: hasRoleInfo && !manager,
    raw: m,
  }
}

// —— 踢人 / 禁言 ——
export async function kickMember(session: Session, guildId: string, userId: string, permanent = true): Promise<void> {
  const cap = getCapabilities(session)
  if (!cap.kick || !session.bot?.kickGuildMember) {
    throw new Error(describeUnsupported('kick'))
  }
  await session.bot.kickGuildMember(guildId, userId, permanent)
}

export async function muteMember(session: Session, guildId: string, userId: string, seconds: number): Promise<void> {
  const cap = getCapabilities(session)
  if (!cap.mute || !session.bot?.muteGuildMember) {
    throw new Error(describeUnsupported('mute'))
  }
  // 统一 API：duration 毫秒
  await session.bot.muteGuildMember(guildId, userId, seconds * 1000)
}

// —— 取陌生人昵称（仅 onebot / qqguild 可用）——
export async function getStrangerNickname(session: Session, userId: string): Promise<string | null> {
  const cap = getCapabilities(session)
  if (!cap.strangerNickname || !session.bot?.getUser) return null
  try {
    const u = await session.bot.getUser(userId)
    return u?.name ?? (u as any)?.nick ?? null
  } catch {
    return null
  }
}
