import { Client, type API } from "@discordjs/core";
import { DiscordAPIError, REST } from "@discordjs/rest";
import { WebSocketManager } from "@discordjs/ws";
import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  InteractionType,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  Routes,
  SelectMenuDefaultValueType,
  ThreadAutoArchiveDuration,
  UserFlags,
  type APIModalInteractionResponseCallbackData,
  type GatewayGuildMemberAddDispatchData,
  type RESTGetAPIGatewayBotResult,
  type RESTPostAPIChannelMessageJSONBody,
} from "discord-api-types/v10";
import * as db from "./db";
import { commands } from "./commands";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN environment variable not set.");

process.title = "Join Guard";

process.on("uncaughtException", (err) => {
  console.error(`Unhandled Exception: ${err}`);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

const rest = new REST({ version: "10" }).setToken(token);
const gateway = new WebSocketManager({
  token,
  // GuildMembers is required for the GuildMemberAdd event
  intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers,
  shardCount: null,
});

const client = new Client({ rest, gateway });

client.once(GatewayDispatchEvents.Ready, async (c) => {
  console.log(`${c.data.user.username} is ready!`);
  await c.api.applicationCommands.bulkOverwriteGlobalCommands(c.data.user.id, commands);
});

client.on(GatewayDispatchEvents.GuildDelete, async ({ data: guild }) => {
  if (!guild.id || guild.unavailable) return;
  await db.removeGuild(guild.id).catch((err) => console.error(`Failed removing guild data: ${err}`));
});

const DEFAULT_AVATAR_HASHES = new Set([
  "157e517cdbf371a47aaead44675714a3",
  "1628fc11e7961d85181295493426b775",
  "5445ffd7ffb201a98393cbdf684ea4b1",
  "79ee349b6511e2000af8a32fb8a6974e",
  "8569adcbd36c70a7578c017bf5604ea5",
  "f7f2e9361e8a54ce6e72580ac7b967af",
  "6c5996770c985bcd6e5b68131ff2ba04",
  "c82b3fa769ed6e6ffdea579381ed5f5c",
]);

const CHECK_DESCRIPTIONS: Record<db.JoinGuardCheck, string> = {
  [db.JoinGuardCheck.RecentAccount]: "Accounts created in the last 15 days",
  [db.JoinGuardCheck.Flagged]: "Spammer/quarantined flags or unusual DM activity",
  [db.JoinGuardCheck.DefaultPfp]: "No avatar or one of Discord's default avatars",
  [db.JoinGuardCheck.NoGlobalName]: "Only a username, no display name",
};

type ScreeningMember = GatewayGuildMemberAddDispatchData & {
  unusual_dm_activity_until?: string | null;
};

const hasPerms = (perms: bigint, needed: bigint) =>
  (perms & PermissionFlagsBits.Administrator) !== 0n || (perms & needed) === needed;

const hasFlag = (flags: number | bigint, flag: number | bigint): boolean =>
  (BigInt(flags) & BigInt(flag)) !== 0n;

const snowflakeDate = (id: string) =>
  Math.floor(Number(BigInt(id) >> 22n) / 1000 + 1420070400);

const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

function formatAccountAge(seconds: number): string {
  if (seconds < 60) return "moments";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} minutes`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} hours`;
  return `${Math.floor(seconds / 86_400)} days`;
}

function enabledCheckLabels(checks: number): string[] {
  return (Object.values(db.JoinGuardCheck) as db.JoinGuardCheck[])
    .filter((flag) => typeof flag === "number" && hasFlag(checks, flag))
    .map((flag) => db.CHECK_LABELS[flag]);
}

const checkList = (checks: number) => enabledCheckLabels(checks).join(", ") || "screening";

/** Returns the reasons a member should be quarantined, or an empty list. */
function screenMember(
  config: db.JoinGuardConfig,
  member: ScreeningMember,
): { reasons: string[]; failedChecks: number } {
  const user = member.user;
  const reasons: string[] = [];
  let failedChecks = 0;
  const checks = config.checks;

  const fail = (check: db.JoinGuardCheck, reason: string) => {
    failedChecks |= check;
    reasons.push(reason);
  };

  if (hasFlag(checks, db.JoinGuardCheck.RecentAccount)) {
    const age = Date.now() / 1000 - snowflakeDate(user.id);
    const FIFTEEN_DAYS_SECONDS = 15 * 86_400;
    if (age <= FIFTEEN_DAYS_SECONDS) {
      fail(db.JoinGuardCheck.RecentAccount, `account is ${formatAccountAge(age)} old`);
    }
  }

  if (hasFlag(checks, db.JoinGuardCheck.Flagged)) {
    const flags = user.public_flags ?? user.flags ?? 0;
    if (hasFlag(flags, UserFlags.Spammer)) {
      fail(db.JoinGuardCheck.Flagged, "flagged as a spammer");
    }
    if (hasFlag(flags, UserFlags.Quarantined)) {
      fail(db.JoinGuardCheck.Flagged, "quarantined by Discord");
    }

    const unusualDmUntil = member.unusual_dm_activity_until;
    if (unusualDmUntil && Date.parse(unusualDmUntil) > Date.now()) {
      fail(db.JoinGuardCheck.Flagged, "unusual DM activity");
    }
  }

  if (hasFlag(checks, db.JoinGuardCheck.DefaultPfp)) {
    const isDefault = (!user.avatar || DEFAULT_AVATAR_HASHES.has(user.avatar))
    const hasDecoration = !!(user.avatar_decoration_data || user.collectibles?.nameplate);
    if (isDefault && !hasDecoration) {
      fail(db.JoinGuardCheck.DefaultPfp, "using a default avatar");
    }
  }

  if (hasFlag(checks, db.JoinGuardCheck.NoGlobalName)) {
    if (!user.global_name) fail(db.JoinGuardCheck.NoGlobalName, "has no global name");
  }

  return { reasons, failedChecks };
}

function warningMessage(): RESTPostAPIChannelMessageJSONBody {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: ComponentType.Container,
        // accent_color: 0xe67e22,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: "## Join Guard",
          },
          {
            type: ComponentType.TextDisplay,
            content: "New members are screened before they get access to the server. Most members pass, but some accounts are quarantined for further verification.",
          },
          {
            type: ComponentType.TextDisplay,
            content: "If you were quarantined, press the button below to open your private verification thread.",
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                label: "Open verification thread",
                custom_id: "join-guard:thread",
              },
            ],
          },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

function configModal(config: db.JoinGuardConfig): APIModalInteractionResponseCallbackData {
  const checkDefaults = (flag: db.JoinGuardCheck) => hasFlag(config.checks, flag);

  return {
    custom_id: "join-guard:config",
    title: "Join Guard",
    components: [
      {
        type: ComponentType.TextDisplay,
        content: [
          "## How Join Guard works:",
          "- Members matching any rule below get the **quarantine role** and a private thread in the **quarantine channel**.",
          "- They stay quarantined until they verify, or get kicked when time runs out.",
          "- The quarantine role should hide all other channels and be the only role that grants access to the quarantine channel.",
        ].join("\n"),
      },
      {
        type: ComponentType.Label,
        label: "Quarantine channel",
        description: "Private verification threads are opened here",
        component: {
          type: ComponentType.ChannelSelect,
          custom_id: "quarantine_channel",
          channel_types: [ChannelType.GuildText],
          min_values: 1,
          max_values: 1,
          required: true,
          placeholder: "#quarantine",
          default_values: config.quarantine_channel_id
            ? [{ id: config.quarantine_channel_id, type: SelectMenuDefaultValueType.Channel }]
            : [],
        },
      },
      {
        type: ComponentType.Label,
        label: "Quarantine role",
        description: "The role given to members who fail screening",
        component: {
          type: ComponentType.RoleSelect,
          custom_id: "quarantine_role",
          min_values: 1,
          max_values: 1,
          required: true,
          placeholder: "@Quarantined",
          default_values: config.quarantine_role_id
            ? [{ id: config.quarantine_role_id, type: SelectMenuDefaultValueType.Role }]
            : [],
        },
      },
      {
        type: ComponentType.Label,
        label: "Screening options",
        description: "Members matching any checked rule are quarantined",
        component: {
          type: ComponentType.CheckboxGroup,
          custom_id: "checks",
          options: [
            {
              value: String(db.JoinGuardCheck.RecentAccount),
              label: "Recent accounts",
              description: CHECK_DESCRIPTIONS[db.JoinGuardCheck.RecentAccount],
              default: checkDefaults(db.JoinGuardCheck.RecentAccount),
            },
            {
              value: String(db.JoinGuardCheck.Flagged),
              label: "Spammer flags",
              description: CHECK_DESCRIPTIONS[db.JoinGuardCheck.Flagged],
              default: checkDefaults(db.JoinGuardCheck.Flagged),
            },
            {
              value: String(db.JoinGuardCheck.DefaultPfp),
              label: "Default avatars",
              description: CHECK_DESCRIPTIONS[db.JoinGuardCheck.DefaultPfp],
              default: checkDefaults(db.JoinGuardCheck.DefaultPfp),
            },
            {
              value: String(db.JoinGuardCheck.NoGlobalName),
              label: "No global name",
              description: CHECK_DESCRIPTIONS[db.JoinGuardCheck.NoGlobalName],
              default: checkDefaults(db.JoinGuardCheck.NoGlobalName),
            },
          ],
          min_values: 0,
          max_values: 4,
          required: false,
        },
      },
      {
        type: ComponentType.Label,
        label: "Log channel",
        description: "Optional channel for quarantine, verification and kick logs",
        component: {
          type: ComponentType.ChannelSelect,
          custom_id: "log_channel",
          channel_types: [ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread],
          min_values: 0,
          max_values: 1,
          required: false,
          placeholder: "No log channel",
          default_values: config.log_channel_id
            ? [{ id: config.log_channel_id, type: SelectMenuDefaultValueType.Channel }]
            : [],
        },
      },
    ],
  };
}

function verifyModal(): APIModalInteractionResponseCallbackData {
  return {
    custom_id: "join-guard:verify-modal",
    title: "Verification",
    components: [
      {
        type: ComponentType.TextDisplay,
        content: [
          "## Human check",
          "Before I restore your access, please confirm you're a real person and not a robot. This is a highly scientific test.",
        ].join("\n"),
      },
      {
        type: ComponentType.Label,
        label: "I'm not a robot",
        description: "Check the box to prove your humanity",
        component: {
          type: ComponentType.Checkbox,
          custom_id: "not_a_robot",
          default: false,
        },
      },
    ],
  };
}

type LogRef = { channelId: string; messageId: string };

const notifiedFailures = new Set<string>();

async function logScreening(
  api: API,
  guildId: string,
  content: string,
  replyTo?: { channelId: string | null; messageId: string | null },
): Promise<LogRef | null> {
  try {
    const config = await db.getConfig(guildId);
    const channelId = replyTo?.channelId ?? config.log_channel_id;
    if (!channelId) return null;

    const body: RESTPostAPIChannelMessageJSONBody = {
      content,
      allowed_mentions: { parse: [] },
      message_reference: replyTo?.messageId ? { message_id: replyTo.messageId, fail_if_not_exists: false } : undefined,
    };

    let targetChannelId = channelId;

    try {
      const message = await api.channels.createMessage(targetChannelId, body);
      return { channelId: targetChannelId, messageId: message.id };
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMessage) {
        delete body.message_reference;
        const message = await api.channels.createMessage(targetChannelId, body);
        return { channelId: targetChannelId, messageId: message.id };
      }

      if (
        err instanceof DiscordAPIError &&
        err.code === RESTJSONErrorCodes.UnknownChannel &&
        config.log_channel_id &&
        config.log_channel_id !== targetChannelId
      ) {
        targetChannelId = config.log_channel_id;
        delete body.message_reference;
        const message = await api.channels.createMessage(targetChannelId, body);
        return { channelId: targetChannelId, messageId: message.id };
      }

      throw err;
    }
  } catch (err) {
    console.error(`Failed sending Join Guard log: ${err}`);
    return null;
  }
}

async function logFailureOnce(
  api: API,
  guildId: string,
  key: string,
  content: string,
  replyTo?: { channelId: string | null; messageId: string | null },
): Promise<void> {
  if (notifiedFailures.has(key)) return;
  const ref = await logScreening(api, guildId, content, replyTo);
  if (ref) notifiedFailures.add(key);
}

async function deleteQuarantineThread(
  api: API,
  guildId: string,
  threadId: string,
): Promise<void> {
  try {
    await api.channels.delete(threadId, { reason: "Join Guard: quarantine finished" });
  } catch (err) {
    console.log(`Failed deleting quarantine thread: ${err}`);
  }
}

async function quarantineMember(
  api: API,
  config: db.JoinGuardConfig,
  member: ScreeningMember,
  reasons: string[],
  failedChecks: number,
): Promise<void> {
  const guildId = member.guild_id;
  const userId = member.user.id;
  const channelId = config.quarantine_channel_id!;
  const roleId = config.quarantine_role_id!;
  const reason = truncate(`Join Guard: ${reasons.join("; ")}`, 512);

  try {
    await api.guilds.addRoleToMember(guildId, userId, roleId, { reason });
  } catch (err) {
    console.error(`Failed adding quarantine role: ${err}`);
    await logScreening(
      api,
      guildId,
      `I couldn't give the quarantine role to <@${userId}>. Please check my **Manage Roles** permission and role position.`,
    );
    return;
  }

  const expiresAt = Math.floor(Date.now() / 1000) + db.VERIFY_WINDOW_SECONDS;
  const displayName = (member.nick ?? member.user.global_name ?? member.user.username)
    .replace(/\s+/g, " ")
    .trim();

  let threadId: string;
  try {
    const thread = await api.channels.createThread(
      channelId,
      {
        name: truncate(`${displayName} (verification)`, 100),
        type: ChannelType.PrivateThread,
        invitable: false,
        auto_archive_duration: ThreadAutoArchiveDuration.OneDay,
      },
      undefined,
      { reason },
    );
    threadId = thread.id;
  } catch (err) {
    console.error(`Failed creating quarantine thread: ${err}`);
    try {
      await api.guilds.removeRoleFromMember(guildId, userId, roleId, {
        reason: "Join Guard: couldn't create a verification thread",
      });
      await logScreening(
        api,
        guildId,
        `I couldn't quarantine <@${userId}> because I couldn't create a verification thread, so I removed the quarantine role. Please check my **Create Private Threads** and **Manage Threads** permissions in the quarantine channel.`,
      );
    } catch (cleanupErr) {
      console.log(`Failed removing quarantine role: ${cleanupErr}`);
      await logScreening(
        api,
        guildId,
        `I couldn't quarantine <@${userId}> because I couldn't create a verification thread, and I also couldn't remove the quarantine role. Please help them manually.`,
      );
    }
    return;
  }

  await db.createQuarantine({
    guild_id: guildId,
    user_id: userId,
    thread_id: threadId,
    role_id: roleId,
    reasons,
    failed_checks: failedChecks,
    expires_at: expiresAt,
  });

  await api.channels
    .createMessage(threadId, {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.Container,
          accent_color: 0xe67e22,
          components: [
            {
              type: ComponentType.TextDisplay,
              content: [
                "## Verify to get access",
                `<@${userId}> you have been quarantined because new members are screened for suspicious activity.`,
              ].join("\n"),
            },
            {
              type: ComponentType.TextDisplay,
              content: [
                "**Why you are here:**",
                ...reasons.map((r) => `- ${r}`),
              ].join("\n"),
            },
            {
              type: ComponentType.TextDisplay,
              content: [
                "Press the button below to verify and restore your access.",
                `-# You will be automatically removed if you don't verify <t:${expiresAt}:R>.`,
              ].join("\n"),
            },
            {
              type: ComponentType.ActionRow,
              components: [
                {
                  type: ComponentType.Button,
                  style: ButtonStyle.Success,
                  label: "Verify me",
                  custom_id: "join-guard:verify",
                },
              ],
            },
          ],
        },
      ],
      allowed_mentions: { parse: [], users: [userId] },
    })
    .catch(async (err) => {
      console.log(`Failed sending verification message: ${err}`);
      await logScreening(
        api,
        guildId,
        `I couldn't send the verification message to <@${userId}>'s thread. Please check the thread and help them verify manually.`,
      );
    });

  const logRef = await logScreening(
    api,
    guildId,
    `<@${userId}> was quarantined for failing the ${checkList(failedChecks)} checks.`,
  );
  if (logRef) {
    await db.setQuarantineLog(guildId, userId, threadId, logRef.channelId, logRef.messageId);
  }

  try {
    await api.threads.addMember(threadId, userId)
  } catch (err) {
    console.log(`Failed adding member to quarantine thread: ${err}`);
  }
}

async function kickForExpiry(api: API, row: db.QuarantineRow): Promise<void> {
  await db.setQuarantineStatus(row.guild_id, row.user_id, db.QuarantineStatus.Kicked);

  // try {
  //   const dm = await api.users.createDM(row.user_id);
  //   await api.channels.createMessage(dm.id, {
  //     content:
  //       "You were removed from a server because you did not complete verification in time. You can rejoin and try again if you think this was a mistake.",
  //     allowed_mentions: { parse: [] },
  //   });
  // } catch {
  //   // DMs are best-effort
  // }


  const logRef =
    row.log_channel_id && row.log_message_id
      ? { channelId: row.log_channel_id, messageId: row.log_message_id }
      : undefined;

  try {
    await api.guilds.removeMember(row.guild_id, row.user_id, {
      reason: "Join Guard: verification timed out",
    });
  } catch (err) {
    if (!(err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMember)) {
      // Leave the row pending so the next poll retries instead of pretending they were kicked
      console.log(`Failed kicking member: ${err}`);
      await logFailureOnce(
        api,
        row.guild_id,
        `${row.guild_id}:${row.user_id}:kick:${row.created_at}`,
        `<@${row.user_id}> didn't verify in time, but I couldn't kick them. Please kick them manually.`,
        logRef,
      );
      return;
    }
  }

  await logScreening(
    api,
    row.guild_id,
    `<@${row.user_id}> was kicked for failing the ${checkList(row.failed_checks)} checks.`,
    logRef,
  );

  await deleteQuarantineThread(api, row.guild_id, row.thread_id);
}

let polling = false;
async function pollExpired(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    for (const row of await db.getExpiredQuarantines(now)) {
      try {
        await kickForExpiry(client.api, row);
      } catch (err) {
        console.error(`Failed processing expired quarantine: ${err}`);
      }
    }
  } catch (err) {
    console.error(`Failed polling expired quarantines: ${err}`);
  } finally {
    polling = false;
  }
}

setInterval(() => void pollExpired(), 60_000).unref();

// New member -> screen -> quarantine
client.on(GatewayDispatchEvents.GuildMemberAdd, async ({ data: member, api }) => {
  try {
    if (member.user.bot) return;

    const config = await db.getConfig(member.guild_id);
    if (!config.quarantine_channel_id || !config.quarantine_role_id) return;

    const screening = screenMember(config, member);
    if (screening.reasons.length === 0) return;

    await quarantineMember(api, config, member, screening.reasons, screening.failedChecks);
  } catch (err) {
    console.log(`Failed screening member: ${err}`);
  }
});

// They left (or were kicked) while quarantined -> stop polling them
client.on(GatewayDispatchEvents.GuildMemberRemove, async ({ data: member }) => {
  if (member.user.bot) return;
  await Bun.sleep(1000); // wait a second for the db to really be updated

  const row = await db.getQuarantine(member.guild_id, member.user.id);
  if (!row || !row.role_id) return;
  if (row.status !== db.QuarantineStatus.Pending) return;

  await db
    .setQuarantineStatus(member.guild_id, member.user.id, db.QuarantineStatus.Left)
    .catch((err) => console.error(`Failed updating quarantine after member left: ${err}`));

  await deleteQuarantineThread(client.api, member.guild_id, row.thread_id).catch((err) => console.error(`Failed deleting quarantine thread after member left: ${err}`));

  const logRef = row.log_channel_id && row.log_message_id ? { channelId: row.log_channel_id, messageId: row.log_message_id } : undefined
  logScreening(client.api, member.guild_id, `<@${member.user.id}> left the server while quarantined.`, logRef).catch((err) =>
    console.error(`Failed logging member left: ${err}`),
  );

});

// They lost the role manually while quarantined -> stop polling them
client.on(GatewayDispatchEvents.GuildMemberUpdate, async ({ data: member, api }) => {
  if (member.user.bot) return;

  await Bun.sleep(1000); // wait a second for the db to really be updated

  const row = await db.getQuarantine(member.guild_id, member.user.id);
  if (!row || !row.role_id) return;
  if (row.status !== db.QuarantineStatus.Pending) return;

  const hasRole = member.roles.includes(row.role_id);
  if (hasRole && !member.pending) {
    api.threads.addMember(row.thread_id, member.user.id)
      .catch((err) => console.error(`Failed adding member back to quarantine thread: ${err}`));
  } else if (!hasRole) {
    await db.setQuarantineStatus(member.guild_id, member.user.id, db.QuarantineStatus.Passed).catch((err) =>
      console.error(`Failed updating quarantine after role removed: ${err}`),
    );

    await deleteQuarantineThread(client.api, member.guild_id, row.thread_id)
      .catch((err) => console.error(`Failed deleting quarantine thread after role removed: ${err}`));

    const logRef = row.log_channel_id && row.log_message_id ? { channelId: row.log_channel_id, messageId: row.log_message_id } : undefined
    logScreening(client.api, member.guild_id, `<@${member.user.id}> lost the quarantine role while quarantined. They are now marked as verified.`, logRef).catch((err) =>
      console.error(`Failed logging role removed: ${err}`),
    );
  }
});

client.on(GatewayDispatchEvents.InteractionCreate, async ({ data: interaction, api }) => {
  const guildId = interaction.guild_id;
  if (!guildId) return;

  try {
    // /join-guard -> open the setup modal
    if (interaction.type === InteractionType.ApplicationCommand && interaction.data.name === "join-guard") {
      const config = await db.getConfig(guildId);
      await api.interactions.createModal(interaction.id, interaction.token, configModal(config));
      return;
    }

    // setup modal submit -> validate & save
    if (interaction.type === InteractionType.ModalSubmit && interaction.data.custom_id === "join-guard:config") {
      const prevConfig = await db.getConfig(guildId);
      let channelId = prevConfig.quarantine_channel_id;
      let roleId = prevConfig.quarantine_role_id;
      let logChannelId = prevConfig.log_channel_id;
      let checks = 0;

      for (const label of interaction.data.components) {
        if (label.type !== ComponentType.Label) continue;
        const component = label.component;
        if (!component) continue;

        if (component.type === ComponentType.ChannelSelect && component.custom_id === "quarantine_channel") {
          channelId = component.values[0] ?? channelId;
        } else if (component.type === ComponentType.RoleSelect && component.custom_id === "quarantine_role") {
          roleId = component.values[0] ?? roleId;
        } else if (component.type === ComponentType.ChannelSelect && component.custom_id === "log_channel") {
          logChannelId = component.values[0] ?? null;
        } else if (component.type === ComponentType.CheckboxGroup && component.custom_id === "checks") {
          checks = component.values.reduce((mask, value) => mask | Number(value), 0);
        }
      }

      const reply = (content: string, ephemeral: boolean = false) =>
        api.interactions.reply(interaction.id, interaction.token, {
          content,
          allowed_mentions: {},
          flags: ephemeral ? MessageFlags.Ephemeral : undefined,
        });

      const reject = (content: string) => reply(`${content}\n-# No settings have been changed.`, true);

      if (!channelId) return reject("You must select a quarantine channel.");
      if (!roleId) return reject("You must select a quarantine role.");

      const resolvedChannel = interaction.data.resolved?.channels?.[channelId];
      if (!resolvedChannel) {
        return reject(`<#${channelId}> couldn't be found — it may have been deleted.`);
      }
      if (resolvedChannel.type !== ChannelType.GuildText) {
        return reject("The quarantine channel must be a normal text channel.");
      }

      const needed =
        PermissionFlagsBits.ViewChannel |
        PermissionFlagsBits.SendMessages |
        PermissionFlagsBits.CreatePrivateThreads |
        PermissionFlagsBits.SendMessagesInThreads |
        PermissionFlagsBits.ManageThreads;
      const neededLabels =
        "**View Channel**, **Send Messages**, **Create Private Threads**, **Send Messages in Threads** and **Manage Threads**";

      if (!hasPerms(BigInt(resolvedChannel.app_permissions ?? "0"), needed)) {
        return reject(`I can't quarantine members in <#${channelId}> — I need the ${neededLabels} permissions there.`);
      }
      if (!hasPerms(BigInt(resolvedChannel.permissions ?? "0"), needed)) {
        return reject(`You need the ${neededLabels} permissions in <#${channelId}> to use it as the quarantine channel.`);
      }

      if (logChannelId) {
        const logChannel = interaction.data.resolved?.channels?.[logChannelId];
        if (!logChannel) {
          return reject(`<#${logChannelId}> couldn't be found — it may have been deleted.`);
        }

        const logNeeded = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages;
        if (!hasPerms(BigInt(logChannel.app_permissions ?? "0"), logNeeded)) {
          return reject(`I can't send screening logs to <#${logChannelId}> — I need **View Channel** and **Send Messages** there.`);
        }
        if (!hasPerms(BigInt(logChannel.permissions ?? "0"), logNeeded)) {
          return reject(`You need **View Channel** and **Send Messages** in <#${logChannelId}> to use it as the log channel.`);
        }
      }

      if (roleId === guildId) {
        return reject("You can't use @everyone as the quarantine role.");
      }

      const role = interaction.data.resolved?.roles?.[roleId];
      if (!role) {
        return reject(`<@&${roleId}> couldn't be found — it may have been deleted.`);
      }
      if (role.managed) {
        return reject(`<@&${roleId}> is managed by an integration, so I can't assign it.`);
      }

      await db.setConfig(guildId, {
        quarantine_channel_id: channelId,
        quarantine_role_id: roleId,
        log_channel_id: logChannelId,
        checks,
      });

      await reply([
        "Join Guard is set up!",
        `-# **Quarantine channel:** <#${channelId}>`,
        `-# **Quarantine role:** <@&${roleId}>`,
        `-# **Log channel:** ${logChannelId ? `<#${logChannelId}>` : "*(not set)*"}`,
        `-# **Checks:** ${enabledCheckLabels(checks).join(", ") || "none"}`,
        `-# **Time to verify:** 3 hours`,
      ].join("\n"));

      const postSetupFails = [];

      // Send warning if the quarantine channel changed
      if (prevConfig.warning_message_id === null || prevConfig.quarantine_channel_id !== channelId) {
        try {
          const message = await api.channels.createMessage(channelId, warningMessage());
          await db.setWarningMessage(guildId, message.id);
        } catch (err) {
          console.log(`Failed posting Join Guard warning: ${err}`);
          await db.setWarningMessage(guildId, null);
          postSetupFails.push(`I couldn't post the warning message in <#${channelId}>.`);
        }
      }

      // give the bot the quarantine role to test that it can assign it to members
      try {
        await api.guilds.addRoleToMember(guildId, interaction.application_id, roleId, {
          reason: "Join Guard: testing that I can assign the quarantine role",
        });
        await api.guilds.removeRoleFromMember(guildId, interaction.application_id, roleId, {
          reason: "Join Guard: removing test assignment of quarantine role",
        });
      } catch (err) {
        console.log(`Failed testing quarantine role assignment: ${err}`);
        postSetupFails.push(`I couldn't assign the quarantine role <@&${roleId}> to members. Please make sure my role is above it and that I have the **Manage Roles** permission.`);
      }

      // check that everyone role can't see the quarantine channel, but that the quarantine role can
      try {
        const channel = await api.channels.get(channelId);
        if ('permission_overwrites' in channel && Array.isArray(channel.permission_overwrites)) {
          const everyonePerms = channel.permission_overwrites?.find((o) => o.id === guildId);
          if (everyonePerms && hasPerms(BigInt(everyonePerms.allow ?? "0"), PermissionFlagsBits.ViewChannel)) {
            postSetupFails.push(`The @everyone role can see the quarantine channel <#${channelId}>. Please remove that permission.`);
          }
          const quarantinePerms = channel.permission_overwrites?.find((o) => o.id === roleId);
          if (!quarantinePerms || !hasPerms(BigInt(quarantinePerms.allow ?? "0"), PermissionFlagsBits.ViewChannel)) {
            postSetupFails.push(`The quarantine role <@&${roleId}> can't see the quarantine channel <#${channelId}>. Please give it permission to view the channel.`);
          }
        }
      } catch (err) {
        console.log(`Failed checking channel permissions: ${err}`);
        postSetupFails.push(`I couldn't check the permissions for the quarantine channel <#${channelId}>.`);
      }

      if (postSetupFails.length > 0) {
        await api.interactions.followUp(interaction.application_id, interaction.token, {
          content: `⚠️ **Warning:**\n- ${postSetupFails.join("\n- ")}`,
          flags: MessageFlags.Ephemeral,
          allowed_mentions: {},
        });
      }

      return;
    }

    // verify modal submit -> actually verify
    if (interaction.type === InteractionType.ModalSubmit && interaction.data.custom_id === "join-guard:verify-modal") {

      const reply = (content: string) =>
        api.interactions.reply(interaction.id, interaction.token, {
          content,
          allowed_mentions: {},
          flags: MessageFlags.Ephemeral
        });

      const userId = interaction.member?.user.id ?? interaction.user?.id;
      if (!userId) return reply("Couldn't work out who you are.");

      let checked = false;
      for (const label of interaction.data.components) {
        if (label.type !== ComponentType.Label) continue;
        const component = label.component;
        if (component?.type === ComponentType.Checkbox && component.custom_id === "not_a_robot") {
          checked = component.value;
        }
      }
      if (!checked) return reply("You need to check the **I'm not a robot** box first.");

      const quarantine = await db.getQuarantine(guildId, userId);
      if (!quarantine) return reply("You're not in quarantine on this server.");
      if (quarantine.status !== db.QuarantineStatus.Pending) {
        return reply(`This quarantine has already been marked as **${quarantine.status}**.`);
      }
      if (quarantine.thread_id !== interaction.channel_id) {
        return reply("Use the verify button in your own private verification thread.");
      }

      if (quarantine.expires_at && quarantine.expires_at <= Math.floor(Date.now() / 1000)) {
        await kickForExpiry(api, quarantine);
        return reply("Your verification window has expired.");
      }

      const logRef =
        quarantine.log_channel_id && quarantine.log_message_id
          ? { channelId: quarantine.log_channel_id, messageId: quarantine.log_message_id }
          : undefined;


      await db.setQuarantineStatus(guildId, userId, db.QuarantineStatus.Passed);

      try {
        await api.guilds.removeRoleFromMember(guildId, userId, quarantine.role_id, {
          reason: "Join Guard: passed verification",
        });
      } catch (err) {
        if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMember) {
          await db.setQuarantineStatus(guildId, userId, db.QuarantineStatus.Left);
          return reply("You're no longer in this server.");
        }
        console.log(`Failed removing quarantine role from: ${err}`);
        await logFailureOnce(
          api,
          guildId,
          `${guildId}:${userId}:remove-role:${quarantine.created_at}`,
          `<@${userId}> verified, but I couldn't remove their quarantine role. Please remove it manually.`,
          logRef,
        );
        return reply("I couldn't remove the quarantine role. Please contact a moderator.");
      }

      await reply("Verified! Your access has been restored.");

      await logScreening(
        api,
        guildId,
        `<@${userId}> was verified after failing the ${checkList(quarantine.failed_checks)} checks.`,
        logRef,
      );

      await deleteQuarantineThread(api, guildId, quarantine.thread_id);
      return;
    }

    // Buttons
    if (interaction.type === InteractionType.MessageComponent) {
      const userId = interaction.member?.user.id;
      if (!userId) return;

      if (interaction.data.custom_id === "join-guard:thread") {
        const ephemeral = (content: string) =>
          api.interactions.reply(interaction.id, interaction.token, {
            content,
            allowed_mentions: {},
            flags: MessageFlags.Ephemeral,
          });

        const quarantine = await db.getQuarantine(guildId, userId);
        if (!quarantine || quarantine.status !== db.QuarantineStatus.Pending) {
          return ephemeral("You don't have an active quarantine on this server.");
        }

        await api.threads.addMember(quarantine.thread_id, userId).catch(() => null);

        const deadline = quarantine.expires_at
          ? ` Your verification deadline is <t:${quarantine.expires_at}:R>.`
          : "";

        return ephemeral(`Here is your private verification thread: <#${quarantine.thread_id}>.${deadline}`);
      }

      if (interaction.data.custom_id === "join-guard:verify") {
        const ephemeral = (content: string) =>
          api.interactions.reply(interaction.id, interaction.token, {
            content,
            flags: MessageFlags.Ephemeral,
            allowed_mentions: {},
          });

        const quarantine = await db.getQuarantine(guildId, userId);
        if (!quarantine) return ephemeral("You're not in quarantine on this server.");
        if (quarantine.status !== db.QuarantineStatus.Pending) {
          return ephemeral(`This quarantine has already been marked as **${quarantine.status}**.`);
        }
        if (quarantine.thread_id !== interaction.channel_id) {
          return ephemeral("Use the verify button in your own private verification thread.");
        }

        await api.interactions.createModal(interaction.id, interaction.token, verifyModal());
        return;
      }
    }
  } catch (err) {
    let interactionInfo = "";
    if (interaction.type === InteractionType.ApplicationCommand) {
      interactionInfo = `/${interaction.data.name}`;
    } else if (interaction.type === InteractionType.ModalSubmit) {
      interactionInfo = `modal ${interaction.data.custom_id}`;
    } else if (interaction.type === InteractionType.MessageComponent) {
      interactionInfo = `button ${interaction.data.custom_id}`;
    }
    console.error(`Error with InteractionCreate handler [${interactionInfo}]: ${err}`);
  }
});

await db.initDb();
gateway.connect({ gatewayInformation: (await rest.get(Routes.gatewayBot())) as RESTGetAPIGatewayBotResult });
void pollExpired();
