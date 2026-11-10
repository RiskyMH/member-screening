import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  PermissionFlagsBits,
  type RESTPutAPIApplicationCommandsJSONBody,
} from "discord-api-types/v10";

export const commands = [
  {
    name: "join-guard",
    description: "Screen new members and quarantine suspicious accounts.",
    type: ApplicationCommandType.ChatInput,
    default_member_permissions: (PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageRoles | PermissionFlagsBits.KickMembers).toString(),
    integration_types: [ApplicationIntegrationType.GuildInstall],
    contexts: [InteractionContextType.Guild],
  },
] satisfies RESTPutAPIApplicationCommandsJSONBody;
