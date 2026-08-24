// SPDX-License-Identifier: MIT
/**
 * QQ 官方机器人·群聊场景能力补丁
 *
 * 用途：给 `@satorijs/adapter-qq` 的 `QQBot` 类（platform='qq'）打补丁，
 * 在不修改官方包源码的前提下，挂载 satori 协议统一 Bot API 的几个方法，
 * 让 ysyunhei 等基于 satori 的 koishi 插件能在 QQ 官方群里使用禁言 / 撤回 / 状态查询。
 *
 * 实现依据：QQ 官方机器人 API v2 群聊场景
 *   https://bot.qq.com/wiki/develop/api-v2/
 *
 * 注意事项：
 * - 这些方法依赖 `Authorization: QQBot <access_token>` 头，QQBot 实例化后
 *   `_ensureAccessToken()` 会自动把鉴权头写入 `this.http.config.headers`，
 *   所以补丁方法直接使用 `bot.http.*` 即可，无需自行处理鉴权。
 * - 群成员禁言接口单次最多 10 个成员，且只能禁言普通成员，不能操作群主/管理员/机器人。
 * - 群信息查询仅对白名单机器人开放。
 */

import { Context } from 'koishi'

// 仅类型声明，避免在 TS 上报错；运行时通过 typeof import 拿到类引用
import type { QQBot } from '@koishijs/plugin-adapter-qq'

// —— 类型扩展：让 QQBot 在 TS 视角下"长出"补丁方法 ——
declare module '@koishijs/plugin-adapter-qq' {
  interface QQBot {
    /**
     * 禁言群成员。
     * @param guildId group_openid
     * @param userId  member_openid（注意：是 openid，不是 QQ 号）
     * @param duration 禁言时长（毫秒，satori 协议统一单位）
     */
    muteGuildMember(guildId: string, userId: string, duration: number): Promise<void>

    /**
     * 获取机器人在指定群内的状态（角色 / 收消息开关 / 主动消息开关）。
     * @param guildId group_openid
     */
    getGuildBotState(guildId: string): Promise<QQGroupBotState>

    /**
     * 获取群基本信息（仅白名单机器人可用）。
     * @param guildId group_openid
     */
    getGuildInfo(guildId: string): Promise<QQGroupInfo | null>

    /**
     * 拉取入群申请列表（分页）。
     * @param guildId group_openid
     * @param cursor 上一次返回的 next_cursor，首次为空字符串
     * @param limit 每页数量，默认 20，最大 100
     */
    getGroupJoinRequests(guildId: string, cursor?: string, limit?: number): Promise<QQGroupJoinRequestPage>

    /**
     * 审批入群申请（同意 / 拒绝 / 拉黑）。
     * @param guildId group_openid
     * @param openid  申请人的 member_openid
     * @param op     'approve' | 'decline'
     * @param options 额外字段：join_request_id、reject_reason、add_to_member_blacklist
     */
    approveGroupJoinRequest(
      guildId: string,
      openid: string,
      op: 'approve' | 'decline',
      options?: {
        join_request_id?: string
        reject_reason?: string
        add_to_member_blacklist?: boolean
      },
    ): Promise<void>
  }
}

// —— 响应数据结构 ——
export interface QQGroupBotState {
  /** 机器人在群内的角色：'owner' / 'admin' / 'member' */
  member_role: 'owner' | 'admin' | 'member'
  /** 是否接收消息 */
  recv_msg_setting?: number
  /** 是否允许主动消息 */
  allow_proactive_msg?: number
}

export interface QQGroupInfo {
  group_openid: string
  group_name?: string
  group_member_num?: number
  group_tags?: string[]
}

export interface QQGroupJoinRequest {
  join_request_id: string
  member_openid: string
  member_nick?: string
  verify_info?: string
  create_at?: string
}

export interface QQGroupJoinRequestPage {
  list: QQGroupJoinRequest[]
  next_cursor?: string
  finish?: boolean
}

// —— 补丁是否已应用标记 ——
let patched = false

/**
 * 应用补丁。幂等：多次调用安全。
 */
export function applyQQBotGroupPatch(ctx?: Context): void {
  if (patched) return

  // 运行时动态拿 QQBot 类，避免在未安装 @koishijs/plugin-adapter-qq 时启动失败
  let QQBotCtor: any
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    QQBotCtor = require('@koishijs/plugin-adapter-qq').QQBot
      ?? require('@satorijs/adapter-qq').QQBot
  } catch {
    // 用户没安装 QQ 官方适配器（纯 OneBot 用户）：跳过补丁
    ctx?.logger?.warn?.('[ysyunhei-qq-patch] @koishijs/plugin-adapter-qq 未安装，跳过 QQ 群聊能力补丁')
    patched = true
    return
  }

  if (!QQBotCtor?.prototype) {
    patched = true
    return
  }

  const proto: any = QQBotCtor.prototype

  // —— muteGuildMember ——
  // POST /v2/groups/{group_openid}/restrict_chat_setting
  // body: { members: [{ op: 'add'|'update'|'del', member_openid, mute_expire_at: RFC3339 }] }
  // 官方文档：https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_restrict_chat_setting.post.html
  // 单次最多 10 人；最大禁言 30 天；mute_expire_at 是 RFC3339 字符串（带时区，如 2026-08-05T11:23:05+08:00）
  // 机器人需为群管理员；只能禁言普通成员，不能禁言群主/管理员/机器人
  if (typeof proto.muteGuildMember !== 'function') {
    proto.muteGuildMember = async function (this: any, guildId: string, userId: string, duration: number) {
      // duration 单位毫秒（satori 协议）；QQ 官方限制最大 30 天
      const MAX = 30 * 24 * 3600 * 1000
      const capped = Math.min(Math.max(duration, 0), MAX)

      let op: 'add' | 'del'
      let muteExpireAt: string
      if (capped <= 0) {
        op = 'del'
        muteExpireAt = ''
      } else {
        op = 'add'
        // 转 RFC3339 +08:00（QQ 官方示例格式：2026-08-05T11:23:05+08:00，不带毫秒）
        const d = new Date(Date.now() + capped + 8 * 3600 * 1000)
        const yyyy = d.getUTCFullYear()
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
        const dd = String(d.getUTCDate()).padStart(2, '0')
        const hh = String(d.getUTCHours()).padStart(2, '0')
        const mi = String(d.getUTCMinutes()).padStart(2, '0')
        const ss = String(d.getUTCSeconds()).padStart(2, '0')
        muteExpireAt = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+08:00`
      }

      const body = {
        members: [
          {
            op,
            member_openid: String(userId),
            mute_expire_at: muteExpireAt,
          },
        ],
      }
      try {
        await this.http.post(
          `/v2/groups/${encodeURIComponent(guildId)}/restrict_chat_setting`,
          body,
          // 显式声明 Content-Type，避免某些 http 客户端默认不带
          { headers: { 'Content-Type': 'application/json' } },
        )
      } catch (error: any) {
        // 提取 QQ 官方服务端返回的 err_code / message，转成更友好的 Error
        // 典型错误：err_code=40011030 "机器人不是群管理员"
        const respData: any = error?.response?.data
        if (respData && typeof respData === 'object') {
          const code = respData.err_code ?? respData.code
          const msg = respData.message
          if (code !== undefined || msg) {
            const enhanced = new Error(
              `QQ 官方 API 错误 (err_code=${code ?? '?'}): ${msg ?? '未知错误'}`,
            )
            ;(enhanced as any).qqErrCode = code
            ;(enhanced as any).qqErrMessage = msg
            throw enhanced
          }
        }
        throw error
      }
    }
  }

  // —— getGuildBotState ——
  // GET /v2/groups/{group_openid}/bot_state
  if (typeof proto.getGuildBotState !== 'function') {
    proto.getGuildBotState = async function (this: any, guildId: string): Promise<QQGroupBotState> {
      return await this.http.get(`/v2/groups/${encodeURIComponent(guildId)}/bot_state`)
    }
  }

  // —— getGuildInfo ——
  // GET /v2/groups/{group_openid}
  // 注意：仅白名单机器人开放，非白名单会返回错误码；该方法会捕获异常返回 null
  if (typeof proto.getGuildInfo !== 'function') {
    proto.getGuildInfo = async function (this: any, guildId: string): Promise<QQGroupInfo | null> {
      try {
        return await this.http.get(`/v2/groups/${encodeURIComponent(guildId)}`)
      } catch {
        // 非白名单机器人或无权限时返回 null
        return null
      }
    }
  }

  // —— getGroupJoinRequests ——
  // GET /v2/groups/{group_openid}/join_requests?cursor=&limit=
  if (typeof proto.getGroupJoinRequests !== 'function') {
    proto.getGroupJoinRequests = async function (
      this: any,
      guildId: string,
      cursor: string = '',
      limit: number = 20,
    ): Promise<QQGroupJoinRequestPage> {
      const params = new URLSearchParams()
      if (cursor) params.set('cursor', cursor)
      params.set('limit', String(Math.min(Math.max(1, limit), 100)))
      const res = await this.http.get(
        `/v2/groups/${encodeURIComponent(guildId)}/join_requests?${params.toString()}`,
      )
      return {
        list: Array.isArray(res?.list) ? res.list : [],
        next_cursor: res?.next_cursor,
        finish: res?.finish,
      }
    }
  }

  // —— approveGroupJoinRequest ——
  // POST /v2/groups/{group_openid}/join_requests/approve
  // body: { member_openid, op: 'approve'|'decline', join_request_id?, reject_reason?, add_to_member_blacklist? }
  if (typeof proto.approveGroupJoinRequest !== 'function') {
    proto.approveGroupJoinRequest = async function (
      this: any,
      guildId: string,
      openid: string,
      op: 'approve' | 'decline',
      options: {
        join_request_id?: string
        reject_reason?: string
        add_to_member_blacklist?: boolean
      } = {},
    ): Promise<void> {
      const body: Record<string, any> = {
        member_openid: String(openid),
        op,
      }
      if (options.join_request_id != null) body.join_request_id = String(options.join_request_id)
      if (options.reject_reason != null) body.reject_reason = String(options.reject_reason)
      if (options.add_to_member_blacklist != null) body.add_to_member_blacklist = !!options.add_to_member_blacklist
      await this.http.post(
        `/v2/groups/${encodeURIComponent(guildId)}/join_requests/approve`,
        body,
      )
    }
  }

  patched = true
  ctx?.logger?.info?.('[ysyunhei-qq-patch] QQ 群聊能力补丁已应用：muteGuildMember / getGuildBotState / getGuildInfo / getGroupJoinRequests / approveGroupJoinRequest')
}
