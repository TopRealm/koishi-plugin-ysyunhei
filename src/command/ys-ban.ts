// SPDX-License-Identifier: MIT
/**
 * 快速禁言群内成员
 *
 * 主要面向 QQ 官方机器人场景：QQ 官方 v2 群聊里 session.userId 是 openid，
 * ysyunhei.add 的"按 QQ 号禁言"无法工作；本指令通过 @mention 直接拿到目标
 * 在群内的 member_openid，调用 muteGuildMember 完成禁言。
 *
 * 用法：
 *   yunhei ban @用户 <时长>
 *   时长格式由 utils/time2-seconds.ts 解析（天/小时/分钟，可组合，如 "1天2小时"）
 */
import sanitizeErrorMessage from '../utils/sanitize-error-message';
import time2Seconds from '../utils/time2-seconds';
import {
  isSelfManager,
  isCallerManager,
  muteMember,
  getCapabilities,
  describeUnsupported,
} from '../utils/platform';

import type { Context, Session } from 'koishi';
import type Config from '../config';

export default async function ban(
  ctx: Context,
  meta: Session,
  target: string | undefined,
  duration: string | undefined,
  config: Config,
): Promise<string> {
  //检查是否为群聊环境
  if (meta.guildId === undefined) {
    return '错误：请在群组内使用命令。';
  }
  //检查使用者是否为管理（OneBot: admin_qqs 白名单；QQ 官方群: 检测 member_role）
  const callerCheck = isCallerManager(meta, config);
  if (!callerCheck.ok) {
    return '错误：您没有使用该命令的权限。';
  }
  //检查机器人权限（QQ 官方群下 isSelfManager 跳过预检）
  try {
    const check = await isSelfManager(meta);
    if (!check.ok) {
      return '错误：本功能需要机器人为群组管理员，请联系群主设置。';
    }
  } catch (error) {
    return `错误：检查机器人权限失败，可能是机器人未加入该群或API出现问题。原因：${sanitizeErrorMessage(error, config)}`;
  }
  //能力检测：当前适配器必须支持禁言
  const caps = getCapabilities(meta);
  if (!caps.mute) {
    return `错误：${describeUnsupported('mute')}，无法执行禁言操作。`;
  }

  //解析目标用户：优先 koishi 解析的 at 元素 → 原始 mentions 字段 → 字符串参数兜底
  let targetId: string | undefined;
  // 1) koishi 解析出的 at 元素（适配器若把 @ 解析成了 h.at）
  const atEl = (meta as any).elements?.find?.(
    (el: any) => el?.type === 'at' && el.attrs?.id && el.attrs.id !== meta.selfId,
  );
  if (atEl) {
    targetId = String((atEl as any).attrs.id);
  }
  // 2) QQ 官方事件原始 mentions 字段（GROUP_MESSAGE_CREATE 的 author 之外可能附带 mentions）
  if (!targetId) {
    const mentions =
      (meta as any).event?.message?.mentions ??
      (meta as any).event?._raw?.mentions ??
      (meta as any).event?._d?.mentions;
    if (Array.isArray(mentions)) {
      const m = mentions.find(
        (x: any) => x?.member_openid && x.member_openid !== meta.userId,
      );
      if (m) targetId = String(m.member_openid);
    }
  }
  // 3) 命令参数兜底（用户直接传 openid 字符串）
  if (!targetId && target) {
    targetId = String(target);
  }
  if (!targetId) {
    return '错误：未识别到要禁言的目标用户。请使用 `yunhei ban @用户 时长`，或直接传 openid。';
  }

  //时长校验
  if (!duration) {
    return '错误：请指定禁言时长，例如 `yunhei ban @用户 1天2小时`。';
  }
  const seconds = time2Seconds(duration);
  if (seconds <= 0) {
    return '错误：禁言时长格式无效。请使用 `天/小时/分钟` 单位组合，例如 `1天2小时30分钟`。';
  }

  try {
    await muteMember(meta, meta.guildId, targetId, seconds);
    return `已禁言该用户 ${duration}（${seconds} 秒）。`;
  } catch (error: any) {
    // 识别 QQ 官方 API 错误码，给出针对性提示
    const qqCode = (error as any)?.qqErrCode
    if (qqCode === 40011030) {
      return '禁言失败：当前机器人不是群管理员。请联系群主把机器人设为群管理员后重试。\n' +
        '操作方法：群主在 QQ 群里点右上角「...」→「群管理」→「群管理员」→找到机器人→设为管理员。'
    }
    return `禁言失败，可能是权限不足或对方是群主/管理员。错误信息：${sanitizeErrorMessage(error, config)}`;
  }
}
