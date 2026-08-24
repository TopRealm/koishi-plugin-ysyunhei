import sanitizeErrorMessage from '../utils/sanitize-error-message';
import time2Seconds from '../utils/time2-seconds';
import dayRecord from '../utils/day-record';
import {
  getPlatform,
  getCapabilities,
  describeUnsupported,
  isSelfManager,
  isCallerManager,
  kickMember,
  muteMember,
  getStrangerNickname,
} from '../utils/platform';

import type { Context, Session } from 'koishi';
import type Config from '../config';


/**
 * 添加黑名单用户
 * @param ctx koishi上下文
 * @param meta
 * @param qqnum
 * @param level
 * @param desc
 * @param bantime
 * @param config
 * @returns
 * 小声逼逼不想写jdsoc了
 */
export default async function add(ctx: Context, meta: Session, qqnum: string, level: number, desc: string, bantime: string,config: Config) {
  // 检查参数
  if (!qqnum || !level || !desc) {
    return '错误：缺少必要的参数。请使用 `help yunhei.add` 查看正确的指令格式。';
  }
  //检查是否为群聊环境
  if (meta.guildId === undefined) {
    return '错误：请在群组内使用命令。'
  }
  //检查机器人权限
  try {
    const check = await isSelfManager(meta)
    if (!check.ok) {
      return '错误：本功能需要机器人为群组管理员，请联系群主设置。'
    }
  } catch (error) {
  return `错误：检查机器人权限失败，可能是机器人未加入该群或API出现问题。原因：${sanitizeErrorMessage(error, config)}`
  }

  //检查使用者是否为管理
  // OneBot: 走 admin_qqs 白名单；QQ 官方群: 检测消息发送者的 member_role（admin/owner）
  const callerCheck = isCallerManager(meta, config)
  if (!callerCheck.ok) {
    return '错误：您没有使用该命令的权限。'
  }
  //检查等级参数
  if (![1, 2, 3].includes(level)) {
    return '错误：等级参数错误，应为1~3。'
  }
  //封禁时长设置，如果等级为1则设置为一年（31536000s），如果大于1则为永久（0s）
  let expiration: number = level == 1 ? 31536000 : 0
  //获取黑名单用户信息
  try {
    const apiCheck = await ctx.http.get(`https://yunhei.youshou.wiki/get_platform_users?api_key=${config.api_key}&mode=1&search_type=1&account_type=1&account=${qqnum}`)
    if (apiCheck.code !== 1 && apiCheck.data?.length > 0) {
      // 用户已存在于黑名单中，这在 get 接口中可能不算一个“错误”
    } else if (apiCheck.code !== 1 && apiCheck.data?.length === 0) {
      return `错误：无法与云黑系统通信。API返回：${apiCheck.msg || '未知错误'}`;
    }

  // 仅管理员可调用此命令，这里使用配置中映射的“登记人昵称”
  // QQ 官方群下若调用者未在 admin_qqs 中配置（按 member_role 放行），回退为发送者昵称或“群管理员”
  const registration = config.admin_qqs?.[meta.userId]
    ?? (meta as any).event?.user?.name
    ?? (meta as any).username
    ?? '群管理员'
    let post=await ctx.http.post(`https://yunhei.youshou.wiki/add_platform_users?api_key=${config.api_key}&account_type=1&name=${qqnum}&level=${level}&registration=${encodeURIComponent(registration)}&expiration=${expiration}&desc=${encodeURIComponent(dayRecord(desc))}`)
    if (post.code !== 1) {
      return `错误：添加用户失败。API返回：${post.msg || '未知错误'}`
    }

    //显示记录违规时长并执行相关操作
    // 注意：踢人/禁言失败不再中断整体流程——云黑记录已成功，必须返回"已记录违规信息"
    // 把失败原因收集到 followUps 数组，在最终消息里附带说明
    const followUps: string[] = []
    const platformQQ = getPlatform(meta) === 'qq'
    let measure:string=`记录违规信息`
    if (level==1) {  //1级（轻微）仅记录时长一年
      measure += `，时长一年`
    } else if (level==2) {  //2级（中等）记录时长永久并禁言
      measure = '永久' + measure
    } else if (level==3) {  //3级（严重）记录时长永久并踢群
      const caps = getCapabilities(meta)
      if (!caps.kick) {
        // QQ 官方群等不支持踢人平台：仅记录到云黑，不执行踢群
        measure = '永久' + measure + '（当前平台不支持自动踢出群，仅记录云黑）'
      } else {
        try {
          await kickMember(meta, meta.guildId, String(qqnum), true)
          measure = '踢出群并拒绝再次申请，永久' + measure
        } catch (error) {
          // 踢人失败：不中断流程，仅记入提示
          followUps.push(`踢出用户失败：${sanitizeErrorMessage(error, config)}`)
        }
      }
    }
    //禁言处理
    if (!(bantime == undefined)){
      const caps = getCapabilities(meta)
      if (!caps.mute) {
        // QQ 官方群等不支持禁言平台：仅记录到云黑，不执行禁言
        measure += `（当前平台不支持禁言，仅记录云黑）`
        if (platformQQ) {
          followUps.push(`提示：QQ 官方机器人无法按 QQ 号禁言。可改用 \`yunhei ban @用户 ${bantime}\` 快速禁言群内成员。`)
        }
      } else {
        try {
          await muteMember(meta, meta.guildId, String(qqnum), time2Seconds(bantime))
          measure += `并禁言${bantime}`
        } catch (error) {
          // 禁言失败：不中断流程，仅记入提示
          followUps.push(`禁言用户失败：${sanitizeErrorMessage(error, config)}`)
          if (platformQQ) {
            followUps.push(`提示：QQ 官方机器人无法按 QQ 号禁言。可改用 \`yunhei ban @用户 ${bantime}\` 快速禁言群内成员。`)
          }
        }
      }
    }
    //显示处理结果部分
    const finalCheck = await ctx.http.get(`https://yunhei.youshou.wiki/get_platform_users?api_key=${config.api_key}&mode=1&search_type=1&account_type=1&account=${qqnum}`)
    if (finalCheck.code !== 1) {
        return `成功添加用户到云黑，但获取最终信息时出错。API返回：${finalCheck.msg || '未知错误'}`;
    }
    const data = Array.isArray(finalCheck.data) ? (finalCheck.data[0] || null) : finalCheck.data
    if (!data) {
      return `成功添加用户到云黑，但未获取到有效的最终信息。`
    }
    let nickname: string
    try {
      nickname = (await getStrangerNickname(meta, String(data.account_name || qqnum))) ?? String(data.account_name || qqnum)
    } catch {
      nickname = String(data.account_name || qqnum)
    }
    let result = `已将${nickname}（${qqnum}）${measure}。\n违规原因：${data.describe}\n严重程度：${data.level}\n措施：${measure}\n登记人：${data.registration}\n上黑时间：${data.add_time}`
    // 追加失败提示（不阻断"已记录违规信息"主消息）
    if (followUps.length > 0) {
      result += `\n\n${followUps.join('\n')}`
    }
    return result

  } catch (error) {
    return `错误：执行添加操作时遇到意外。原因：${sanitizeErrorMessage(error, config)}`
  }
}
