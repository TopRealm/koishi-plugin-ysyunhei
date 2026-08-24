import sanitizeErrorMessage from '../utils/sanitize-error-message';
import processInBatches from '../utils/processIn-batches';
import {
  getCapabilities,
  describeUnsupported,
  isSelfManager,
  isCallerManager,
  isManager,
  listAllMembers,
  kickMember,
  getStrangerNickname,
} from '../utils/platform';

import type { Context, Session } from 'koishi';
import type Config from '../config';

/**
 * 供整群检查时使用的最小成员结构
 */
interface CheckMember {
  user_id: string
  nickname: string
  /** 是否为群主/管理员等机器人通常无权操作的角色 */
  isPrivileged: boolean
}

/**
 * 查询黑名单用户
 * @param ctx 上下文
 * @param meta
 * @param qqnum
 * @param config
 * @returns
 */
export default async function check(ctx: Context, meta: Session, qqnum: string, config: Config) {
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
  //查询所有用户信息
  if (qqnum===undefined) {
    const caps = getCapabilities(meta)
    if (!caps.listMembers) {
      return `错误：${describeUnsupported('listMembers')}。请改为查询单个用户：\`yunhei.chk <QQ号>\`。`
    }
    let rawMembers
    try {
      rawMembers = await listAllMembers(meta, meta.guildId)
    } catch (error) {
  return `错误：获取群成员列表失败。原因：${sanitizeErrorMessage(error, config)}`
    }

  const membersToCheck: CheckMember[] = rawMembers.members.map(m => ({
    user_id: m.user_id,
    nickname: m.nickname,
    isPrivileged: m.isManager,
  }))
  const totalToCheck = membersToCheck.length
  // 开始时输出群员数量及将要检查的人数（包含管理员与群主）
  meta.send(`正在检查群内所有人员（共${totalToCheck}人）……`)

    let detectnum:number=0,light:number=0,moderate:number=0,severe:number=0,severe_users:string[]=[], api_errors: string[] = []
    // 进度统计与阈值（25%、50%、75%）
    let processedCount = 0
    const thresholds = [0.25, 0.5, 0.75]
    let nextThresholdIndex = 0

    await processInBatches(membersToCheck, async (member: CheckMember) => {
      try {
        const res = await ctx.http.get(
          `https://yunhei.youshou.wiki/get_platform_users?api_key=${config.api_key}&mode=1&search_type=1&account_type=1&account=${member.user_id}`
        )
        if (res.code !== 1 && res.data?.length === 0) {
          // 记录API错误，但不中断整个流程
          if (!api_errors.length) { // 只记录第一条，避免刷屏
            api_errors.push(sanitizeErrorMessage(res.msg || '未知API错误', config));
          }
          return;
        }
        // 等级判定
        const item = Array.isArray(res.data) ? (res.data[0] || null) : res.data
        if (item) {
          detectnum += 1
          if (item.level == `轻微`) {
            light += 1
          } else if (item.level == `中等`) {
            moderate += 1
          } else if (item.level == `严重`) {
            severe += 1
            // 构建严重用户信息并尝试踢群
            severe_users.push(`${member.nickname}（${member.user_id}）\n违规原因：${item.describe}\n登记人：${item.registration}\n上黑时间：${item.add_time}`)
            if (member.isPrivileged) {
              // 群主或管理员，机器人通常无权操作
              severe_users.push(`  - 该成员为群主/管理员，机器人无权进行踢出操作，请手动处理。`)
            } else {
              const caps = getCapabilities(meta)
              if (!caps.kick) {
                // QQ 官方群等不支持踢人平台：仅记录到列表，不执行踢出
                severe_users.push(`  - 当前平台不支持自动踢出，请手动处理。`)
              } else {
                try {
                  await kickMember(meta, meta.guildId, String(member.user_id), true)
                } catch (error) {
                  severe_users.push(`  - 踢出用户 ${member.nickname}（${member.user_id}）失败: ${sanitizeErrorMessage(error, config)}`);
                }
              }
            }
          }
        }
      } catch (error) {
        if (!api_errors.length) { // 只记录第一条网络错误
          api_errors.push(sanitizeErrorMessage(error, config));
        }
      } finally {
        // 进度更新（放在 finally，确保无论成功或失败都统计进度）
        if (totalToCheck > 0) {
          processedCount += 1
          const ratio = processedCount / totalToCheck
          while (nextThresholdIndex < thresholds.length && ratio >= thresholds[nextThresholdIndex]) {
            const percent = Math.round(thresholds[nextThresholdIndex] * 100)
            meta.send(`进度：已完成${percent}%（${processedCount}/${totalToCheck}）`)
            nextThresholdIndex += 1
          }
        }
      }
    }, 10)
    //生成报告
    let report:string
    if (detectnum == 0) {
      report = "未检查出任何位于黑名单内的成员。"
    } else {
        report = `检测到${detectnum}名违规用户。其中等级轻微者${light}人，等级中等者${moderate}人，等级严重者${severe}人。`
        if (!(severe_users.length === 0)){
          report += `\n严重用户列表及处理结果：\n${severe_users.join('\n')}\n其中普通成员已尝试踢出；若为群主/管理员，请手动处理。`
        }
    }
    if (api_errors.length > 0) {
      report += `\n\n在检查过程中遇到一个或多个错误，可能导致部分用户未被正确查询。遇到的第一个错误是：${api_errors[0]}`
    }
    meta.send(`${report}\n检查完毕，感谢您的使用。`)
  } else {
    //查询单个用户信息
    try {
      let blacklist_person=await ctx.http.get(`https://yunhei.youshou.wiki/get_platform_users?api_key=${config.api_key}&mode=1&search_type=1&account_type=1&account=${qqnum}`)
      if (blacklist_person.code !== 1) {
        return `错误：查询用户失败。API返回：${blacklist_person.msg || '未知错误'}`
      }
      if (Array.isArray(blacklist_person.data) && blacklist_person.data.length === 0) {
        return `查询成功，该用户不在黑名单中。`
      } else {
        const data = Array.isArray(blacklist_person.data) ? (blacklist_person.data[0] || null) : blacklist_person.data
        if (!data) return `查询成功，该用户不在黑名单中。`
        let nickname: string
        try {
          nickname = (await getStrangerNickname(meta, String(data.account_name))) ?? String(data.account_name)
        } catch {
          nickname = String(data.account_name)
        }
        let res:string=`账号类型：${data.platform}\n用户名：${nickname}\nQQ号：${data.account_name}\n违规原因：${data.describe}\n严重等级：${data.level}\n登记人：${data.registration}\n上黑时间：${data.add_time}\n过期时间：${data.expiration}\n查询云黑请见：https://yunhei.youshou.wiki`
        return res
      }
  } catch (error) {return `错误：查询用户失败，请检查网络连接或API状态。原因：${sanitizeErrorMessage(error, config)}`}
  }
}
